# Changelog

All notable changes to `@openparachute/hub` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/) loosely; versions follow [SemVer](https://semver.org/) with the pre-1.0 RC governance described in [`parachute-patterns/patterns/governance.md`](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/governance.md).

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
