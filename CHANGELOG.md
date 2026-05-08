# Changelog

All notable changes to `@openparachute/hub` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/) loosely; versions follow [SemVer](https://semver.org/) with the pre-1.0 RC governance described in [`parachute-patterns/patterns/governance.md`](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/governance.md).

## [0.5.7-rc.1] - 2026-05-08

Adds a second auto-approve path on RFC 7591 Dynamic Client Registration: a valid `parachute_hub_session` cookie plus a same-origin `Origin`/`Referer` header skips the manual `parachute auth approve-client` step. The operator hitting their own SPA from their own browser is by definition operator-authenticated; re-requiring approval was friction without benefit.

### Added

- **`/oauth/register` auto-approves when a valid session cookie + matching Origin/Referer is present (closes #199).** Companion path to the operator-bearer (`hub:admin`) auto-approve introduced in #74. Surfaced 2026-05-08 when Aaron tried to link Notes to a vault and hit "App not yet approved" on `POST /oauth/authorize` — every fresh `client_id` from a browser SPA needed a terminal drop-out. Two gates in the new path: (1) `findActiveSession(db, req)` — un-expired session row keyed by the `parachute_hub_session` cookie, (2) `originMatchesIssuer(req, issuer)` — `URL.origin` exact match (scheme + host + port) against the request's `Origin` (or `Referer` as fallback). Belt-and-suspenders CSRF defense alongside the cookie's `SameSite=Lax` attribute. SPA-side companion work: parachute-agent#140 + parachute-notes#106 (`credentials: 'include'` on the DCR fetch).
- **`findActiveSession(db, req, now?)` exported from `src/sessions.ts`.** Refactor: the private `activeSession` helper from `src/admin-handlers.ts` moved up to `sessions.ts` and renamed for use by both admin handlers and the new DCR cookie-based auto-approve path. DRY: removes the duplicate parse-cookie + find-session + null-check dance.
- **Tests: ten regression cases for the new path (`src/__tests__/oauth-handlers.test.ts`, `DCR auto-approve via session cookie (#199)`).** Valid session + matching Origin → approved (verified in both response body + DB row); valid session + cross-origin Origin → pending (CSRF defense); valid session + `Origin: "null"` (opaque-origin / sandbox-iframe / `data:` document) → pending — `new URL("null")` throws and `originMatchesIssuer`'s try/catch returns false, so opaque-origin callers can't ride the cookie path; exact-origin port-sensitivity (`https://hub.example:8443` ≠ `https://hub.example`); Referer fallback when no Origin header; no Origin AND no Referer → pending (deny without proof of origin); expired session → pending; unknown session id → pending; no cookie → pending; operator-bearer regression test pins #74's path still works without a cookie.

### Why this lands now

Friction every time a fresh `client_id` is created from a browser-side SPA. Aaron hit it earlier today on Notes vault-link; paraclaw#138 surfaced one cache-staleness trigger that creates fresh `client_id`s. The friction will keep coming as more SPAs ship. The hub-side change is independent and ships first; agent + notes' `credentials: 'include'` PRs become effective the moment the deployed hub recognizes the cookie.

## [0.5.6-rc.1] - 2026-05-08

Bundled fix for two `proxyToService` / `proxyToVault` dispatch edge cases that hub#187's tests missed. Both surfaced during operator diagnostics on Aaron's box (2026-05-08); both make the hub silently 404 a real on-box backend.

### Fixed

- **Trailing-slash mount paths now match sub-paths in `findServiceUpstream` / `findVaultUpstream` (closes #197).** A services.json entry written with `paths: ["/notes/"]` (trailing slash) used to match only the exact pathname `/notes/` and never any sub-path, because `pathname.startsWith("/notes//")` is always false (URLs don't have double slashes). Operator-visible symptom on Aaron's box: notes blank screen — the SPA shell loaded at `/notes/` but every `/notes/assets/*.js` request 404'd from hub. Fix: normalize trailing slashes (`path.replace(/\/+$/, "") || "/"`) before the equality + prefix check, in both matchers. The `|| "/"` branch keeps a bare-root mount `"/"` stable rather than collapsing to the empty string. The reported `match.mount` is the normalized form so callers computing `pathname.slice(match.mount.length)` (the stripPrefix path) get a consistent answer regardless of how the entry was written on disk.
- **`proxyToService` / `proxyToVault` honor `stripPrefix` from `FIRST_PARTY_FALLBACKS` when the on-disk entry omits it (closes #196).** Scribe v0.4.0 doesn't write `stripPrefix: true` to its services.json entry — the declaration only lives in hub's `SCRIBE_FALLBACK.manifest.stripPrefix` (`src/service-spec.ts`). Pre-#187 this didn't matter because the per-service `tailscale serve` plan baked the path into the target URL (`/scribe → http://127.0.0.1:1943/scribe`); post-#187 routing went through hub which wasn't consulting the fallback registry. Result: `/scribe/health` got forwarded verbatim to scribe, scribe served bare paths and 404'd. Fix: new `stripPrefixFor(entry)` helper consulted by both proxies — explicit on-entry wins, otherwise consult `FIRST_PARTY_FALLBACKS` keyed by short name (same shape as how `effectivePublicExposure` already handles fallback derivation in service-spec.ts), default `false` (preserving existing keep-prefix default for unknown / third-party services). Scribe-side companion is parachute-scribe#40 (canonical-port-on-boot regression — different diagnostic, same operator). `proxyToVault` gets the same shape for symmetry; no first-party vault fallback declares `stripPrefix` today, so this is a no-op in practice.

### Added

- **Tests: `findServiceUpstream` / `findVaultUpstream` trailing-slash regression coverage (`src/__tests__/hub-server.test.ts`).** Two unit tests pin the new normalization (one each for service and vault matchers), plus a hubFetch end-to-end test that drives a `/notes/assets/index-XXX.js` request through a `paths: ["/notes/"]` entry to a fixture upstream and asserts the path is forwarded verbatim. A bare-root `paths: ["/"]` test pins the `|| "/"` branch's stability without changing the existing exact-match-only contract for catchall mounts.
- **Tests: hubFetch end-to-end coverage for the FIRST_PARTY_FALLBACKS stripPrefix derivation (`src/__tests__/hub-server.test.ts`).** Three tests cover the three precedence rungs: (1) `parachute-scribe` entry without `stripPrefix` resolves to the SCRIBE_FALLBACK's `stripPrefix: true` and the backend sees the bare `/health` path; (2) explicit `stripPrefix: false` on the entry overrides the fallback (full path forwarded); (3) third-party service whose manifestName isn't in FIRST_PARTY_FALLBACKS gets the default keep-prefix behavior (no accidental strip).

### Why this lands now

Both edge cases broke real operator setups today during diagnostics on Aaron's box. Filed as #196 / #197 alongside two further tactical issues (#194 `notes-serve` `Bun.resolveSync` from hub cwd, #195 port collision validation) — those are bigger fixes / separate PRs. This bundle sticks to the two regressions whose root cause is hub#187 missing edge cases in proxy dispatch, so the fix is small and surgical.

## [0.5.5] - 2026-05-08

Promotes the 0.5.5-rc cycle (#187 layer-aware proxy + #188 admin-login rate-limit + #191 2FA-not-enrolled warning) to stable, plus a small content-only / formatting-only housekeeping bundle. Skips the `-rc.N` step per the doc-only-changes rule (no semantic code changes since rc.2). No intermediate RCs were published to npm during the cycle; this is the first publish to `@latest`.

### Changed

- **Refresh stale comment on `effectivePublicExposure` in `src/service-spec.ts` (closes #189).** The pre-#187 comment said `auth-required` services were "treated as loopback at launch." Post-#187 (layer-aware proxy + collapse tailnet to single catchall) `auth-required` reaches all layers and the service self-gates — the loopback-block is the dedicated `loopback` value's job. Comment now spells out the matrix (allowed → all layers, service self-gates; loopback → hub layer-gates; auth-required → all layers, service self-gates, field documents intent). Code unchanged — the function's return values were already correct against #187's contract.
- **Canonicalize test-count invocation in `CLAUDE.md` (closes #190).** New "Test gate counts in commit messages and PR descriptions" subsection under "Running" pins `bun test ./src` (the `package.json` `"test"` script, what CI runs) as the source of gate counts quoted in commit messages and PR descriptions, and calls out that `bun test src/__tests__/` pulls in `packages/scope-guard/` tests and reports an inflated count. Recent PRs reported 1028 vs 1076 from these two invocations — the note is the cheapest way to stop divergence.
- **`bunx biome check src/commands/expose-public-auto.ts --write` fix-up (closes #192).** Pure formatting + import-order fixes (organizeImports + format) that had been failing for multiple PRs. No semantic change. Rest of the repo passes `bunx biome check .` clean.

### Fixed

- **`CLAUDE.md` "Running" fence: harmonize the test command with the canonical `bun test ./src` invocation called out in the "Test gate counts" subsection just below.** Reviewer nit on PR #193 — a reader could reasonably wonder whether the bare `bun test` shown in the fence and the `bun test ./src` shown in the gate-counts subsection were equivalent. They aren't (the bare form pulls in `packages/scope-guard/` and inflates the count). The fence now shows `bun test ./src` with an inline comment back-pointing to the subsection.
- **Biome file count: verified `bunx biome check .` reports `Checked 167 files` at this PR's HEAD, matching the count quoted in the original PR body / CHANGELOG entry.** Reviewer's run reported 166. Re-ran on a clean working tree and via the `summary` reporter — both reproducibly report 167 against the same commit. The formatter pass in `chore(format): biome fix-up on expose-public-auto.ts` was the only thing that changed tree shape during the cycle, and no files were added or removed; most likely cause of the reviewer-side delta is a stale-cache or pre-formatter working state on their end. Stated count stands.

## [0.5.5-rc.2] - 2026-05-08

Review nit fold (PR #191) — no behavior change.

### Added

- **Test: malformed `config.yaml` → `is2FAEnrolled()` returns `false` (`src/__tests__/expose-2fa-warning.test.ts`).** Pins the safer-fail contract — junk YAML doesn't match the regex, the probe resolves to `hasTotp: false`, and the public-exposure warning fires rather than silently suppressing. Guards against a future refactor of `auth-status.ts` quietly inverting the default.

## [0.5.5-rc.1] - 2026-05-08

### Added

- **`parachute expose public` warns when 2FA is not enrolled.** Lands as the next layer of defense after #188's `/admin/login` rate-limit floor. `/admin/login` became reachable across all layers (loopback / tailnet / public) when 0.5.3-rc.1 collapsed the access-control matrix into the hub; on cloudflare or Tailscale Funnel, that's the open internet, where 2FA is the difference between "password is the only wall" and "password + something-you-have." Both bringup paths (`expose-cloudflare.ts` and the public branch of `expose.ts`) now check `readVaultAuthStatus().hasTotp` after the tunnel is up but before returning, and print a contextual warning + the one-line `parachute auth 2fa enroll` remediation when 2FA is absent. Warning-only by design — hard-gating would surprise operators mid-flow; the tunnel is up regardless. Tailnet exposure is moot (tailscale-authed at the proxy) so the warning is public-layer only. (#186)
- **`is2FAEnrolled()` + `printPublic2FAWarning()` helper module (`src/commands/expose-2fa-warning.ts`).** Wraps the existing `readVaultAuthStatus().hasTotp` probe in a focused, testable surface. Source-of-truth is vault's `config.yaml` `totp_secret` field — the hub's `users` table has no TOTP column today (it'll gain one when hub-admin login verifies TOTP against vault). The hub already forwards `parachute auth 2fa enroll` to `parachute-vault` (see `commands/auth.ts` `VAULT_FORWARDED_SUBCOMMANDS`), so the read-side stays consistent with the write-side.
- **`vaultHome` and `vaultAuthStatus` test seams on `ExposeCloudflareOpts` and `ExposeOpts`.** Production callers omit; tests inject either a tmp `vaultHome` (so the probe reads a controlled `config.yaml`) or a pre-computed `VaultAuthStatus` (so the probe is bypassed entirely). Mirrors the pattern `expose-auth-preflight.ts` already uses for the interactive wizard.

### Why this lands now

Rate-limit floor (#188) caps brute-force throughput at 5 attempts / 15-minute sliding window per IP. 2FA is the primary defense once an attacker is past the floor — without TOTP, a leaked password is full admin access. The expose-public moment is the natural surfacing point: it's the only place where the operator's previously-loopback `/admin/login` becomes a public-internet target, and they're already paying attention to security copy from `printAuthGuidance` / the tailnet-public note.

The warning lands ahead of hub-admin TOTP verification on `POST /admin/login` itself — that's a follow-up. Today's flow nudges operators to enroll in vault now so they're ready when verification ships, and so any operator on cloudflare-fronted hub today has the strongest practical defense available.

## [0.5.4-rc.2] - 2026-05-08

Review nit fold (PR #188) — no behavior change.

### Changed

- **Drop unreachable `pruned.length === 0` branch in `checkAndRecord`'s deny path (`src/rate-limit.ts`).** The deny branch only fires when `pruned.length >= MAX_ATTEMPTS`, so the `if (pruned.length === 0) buckets.delete(key)` arm was structurally unreachable; the `else buckets.set(key, pruned)` arm was the only path that ever ran. Replaced the if/else with an unconditional `buckets.set(key, pruned)` plus a comment explaining the deny-bucket-is-still-full intent so a future reader doesn't reintroduce a confused `delete` arm.
- **Document the `Math.max(1, ...)` clamp on `retryAfterSeconds` as defense-in-depth.** The unclamped value is provably `>= 1` in the deny branch (every retained timestamp is strictly inside the window, so `resetAtMs - now > 0` strictly, so `Math.ceil(positiveMs / 1000) >= 1`). The clamp stays as a belt-and-suspenders floor in case the filter logic is ever loosened. JSDoc on `RateLimitResult.retryAfterSeconds` updated to reflect this.

### Added

- **Test: `retryAfterSeconds === 1` at the 1-ms-remaining boundary (`src/__tests__/rate-limit.test.ts`).** Pins the minimum natural value the `Math.ceil((resetAtMs - now) / 1000)` calculation produces in the deny branch, which is what the existing clamp would catch if the filter logic regressed.
- **Test: sweep `now` from t0 across the full window in 100ms steps and assert every denied response has `retryAfterSeconds >= 1`.** Belt-and-suspenders invariant check that the deny branch never produces a sub-1 unclamped value.

## [0.5.4-rc.1] - 2026-05-08

### Added

- **Per-IP rate-limit on `POST /admin/login` (5 attempts / 15-minute sliding window).** Lands as a brute-force floor under `/admin/login`, which became reachable from every layer (loopback / tailnet / public) when 0.5.3-rc.1 collapsed the access-control matrix into the hub. On a cloudflare-fronted hub, that means the open internet — until #186 ships 2FA-on-login, this is the only thing slowing credential grinding. New module `src/rate-limit.ts` keeps a sliding-window timestamp list per IP and is wired into `handleAdminLoginPost` *after* CSRF (so cross-site junk doesn't burn slots) but *before* credential check (so 401s, missing-user, and eventually 2FA failures all count toward the same bucket — auth-stage independent). Exhaustion returns `429 Too Many Requests` with a `Retry-After` header pointing at the bucket-reset moment in seconds. Layer-independent: a buggy script hammering loopback gets 429'd just like a public attacker; tailnet logins all share the loopback bucket since `tailscale serve` proxies from `127.0.0.1`, which is acceptable because brute-force isn't the threat model on an authed-tailnet ingress. (#185)
- **`clientIpFromRequest` IP-extraction helper (`src/rate-limit.ts`).** Priority order: `CF-Connecting-IP` (cloudflared sets this on every forwarded request, with the actual client IP rather than the cloudflare edge); `X-Forwarded-For` first hop (defensive fallback for any non-cloudflare proxy fronting hub); fall through to `UNKNOWN_IP_SENTINEL` so the limiter always has a key (direct-loopback callers all share one bucket, intended bound). No `Forwarded` (RFC 7239) parser today — `X-Forwarded-For` covers the operator-deploy reality and `Forwarded` is rare in this niche; can add when the first deployment needs it. (#185)
- **Storage shape: in-memory `Map<ip, timestamps[]>` for the lifetime of the hub process.** Persistence isn't worth a SQLite write per attempt — process restart is itself a defense (the attacker loses progress against any one bucket). Memory is bounded by an opportunistic prune on every check; sentinel-bucket sharing keeps direct-loopback noise to one entry. (#185)
- **`AdminLoginDeps` test seam on `handleAdminLoginPost`.** Production callers omit it (real clock); tests inject `now` so rate-limit assertions don't race wall-clock time. Kept narrow — login doesn't share the wider `AdminDeps` because it doesn't load services / module manifests. (#185)

### Why this lands now

Pre-#187, `/admin/login` was loopback-only on a tailnet/funnel-only deployment (the route lived on the hub which only listened on `127.0.0.1`). Post-#187 the access-control matrix moved into the hub itself, and every layer that admits requests at all admits `/admin/*`. For operators on cloudflare-only exposure that means a public-internet brute-force surface. 2FA (#186) is the primary defense and ships next; the rate-limit floor lands first because it's small, well-bounded, and gets some of the way there for operators who upgrade before the 2FA PR lands.

## [0.5.3-rc.2] - 2026-05-08

Review nit fold (PR #187) — no behavior change beyond test coverage.

### Changed

- **`layerOf` matches `Tailscale-Funnel-Request: ?1` by value, not presence.** The structured-header value is the contract per `tailscale.com/ipnlocal/serve.go`; comparing on value (rather than `!== null`) makes the classifier's intent explicit and prevents a future loosening from accidentally accepting any value. CF-Ray / CF-Connecting-IP stay on presence-checks (open-string identifiers, no canonical value).
- **`warnLegacyRoot` typed as `void`; unused binding dropped at the call site.** The function has been warning-only since the path-rewrite was removed in 0.5.3-rc.1; `const services = warnLegacyRoot(...)` implied a transform that wasn't happening. Caller now uses `manifest.services` directly downstream.

### Added

- **Test: unknown third-party service (no `FIRST_PARTY_FALLBACKS` row, no explicit `publicExposure`) defaults to `"allowed"` and reaches the public layer.** Regression-guards anyone tightening `effectivePublicExposure`'s default toward `"loopback"` — that would silently 404 every third-party module installed via `module.json` on tailnet/public exposure.

## [0.5.3-rc.1] - 2026-05-08

### Added

- **Hub-side request-layer detection (`layerOf`).** Every request reaching `127.0.0.1:1939` is classified into `loopback` / `tailnet` / `public` by inspecting the proxy headers each trusted forwarder injects: `Tailscale-User-Login` (tailnet, authed via `tailscale serve`), `Tailscale-Funnel-Request: ?1` (public, Tailscale Funnel — verified against `serve.go addTailscaleIdentityHeaders`), `CF-Ray` / `CF-Connecting-IP` (public, cloudflared tunnel), or none of the above (loopback). Spoofing isn't a concern: hub binds 127.0.0.1, so external requests can't reach the listener except via these forwarders. Drives the new `publicExposure` enforcement below.
- **`publicExposure: "loopback"` enforcement on `/<svc>/*` and `/vault/<name>/*` dispatch.** `effectivePublicExposure(entry)` was already exposed by `service-spec.ts`; `proxyToService` and `proxyToVault` now consult it and 404 when the layer mismatches (loopback service hit from tailnet/public). `allowed` and `auth-required` pass through; the service does its own auth. **Hub-owned routes (`/`, `/admin/*`, `/api/*`, `/hub/*`, `/oauth/*`, `/.well-known/*`, `/vault/*` SPA mount, `POST /vaults`) are NOT layer-blocked** — they reach all layers and rely on app-level auth (admin session cookie + 2FA, OAuth, per-route logic). This is the access-control matrix the redirected single-ingress design committed to.

### Changed

- **`parachute expose tailnet up` collapses to a single tailscale rule.** Pre-collapse the planner emitted one mount per service: hub root, well-known, four OAuth proxies, `/vault/`, plus one per non-vault service — eight mounts for a baseline vault+notes install. New shape: `tailscale serve --bg --https=443 --set-path=/ http://127.0.0.1:<hubPort>/` and the hub does all internal dispatch. `parachute expose public` (Tailscale Funnel) emits the symmetric single rule. Closes the symmetry gap with the cloudflare side that shipped in #178 on 0.5.2; the access-control matrix now lives uniformly in the hub regardless of which forwarder admitted the request.
- **`partitionByExposure` removed from the tailnet plan layer.** Its job (filtering loopback/auth-required services off the tailscale plan) is moot now that every service rides the catchall. The hub gates per request via `effectivePublicExposure` + `layerOf`. Operator-visible "X is loopback-only" warnings at expose time are gone — the equivalent operator signal is hub returning 404 for those routes from non-loopback callers.
- **Legacy `paths: ["/"]` entries warn but no longer get rewritten in-memory.** Pre-collapse the planner remapped them to `/<shortname>` so they didn't collide with the hub's tailscale `/` mount. With one catchall, the collision is hub-side; the warning still fires so operators know to re-install. (No services in the wild have ever shipped this shape on a release version.)

### Migration / impact

- Operators with `parachute expose tailnet` already up: re-run after upgrading. The teardown-then-bringup sweep in `exposeUp` handles old multi-mount state correctly via the recorded `entries[]` in `expose-state.json`.
- Operators with `publicExposure: "loopback"` services in `services.json`: behavior is materially equivalent (those routes were unreachable from tailnet/public before because the plan withheld them; now they're 404 because the hub gate fires). `auth-required` services that lacked an actual auth gate: were withheld pre-collapse, now reach all layers and rely on the service to gate. **Verify your service is actually auth-gating before relying on this** (#185 tracks rate-limiting on `/admin/login` since `/admin` is now public-reachable with cloudflare/funnel exposure; #186 tracks an `expose public` warning when 2FA isn't enrolled).
- Tailnet exposure now matches cloudflare: one ingress rule, all policy in hub.

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
