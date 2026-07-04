> Moved from parachute-patterns/patterns/hub-module-boundary.md (2026-07-04) — see the patterns-archive decision. This repo enforces this contract.

# The hub–module boundary

> The hub owns the substrate. Modules own their domain. The seam between
> them: **module surfaces drive hub identity APIs.**

This is the ownership charter the other module patterns hang off. When you
can't tell whether a capability belongs in the hub or in a module, answer
here first.

## The principle

**Irreducibly the hub's (the substrate)** — the things that must have exactly
one answer across all modules:

| Substrate concern | Why it can't be a module's |
|---|---|
| **Identity** — user store, sessions, login/2FA, invites | one answer to "who is this person" across every module |
| **Issuance** — OAuth (DCR, consent, token/refresh), signing keys + JWKS, revocation list, **scope-model enforcement** | every module validates against one issuer; no module can police its siblings' scope claims |
| **Identity transactions** — token mints, grants, connection provisioning, lifecycle *cascades* (revoke/deregister on delete) | anything that mints, grants, or revokes authority is issuance in motion |
| **Transport** — the canonical origin, reverse proxy, trust-layer gating (`layerOf`, `publicExposure`) | one origin, one router; a module can't own the router that routes to it |
| **Catalog** — `/.well-known/parachute.json` aggregation, `/api/modules` | aggregation across siblings; modules *write* their own rows (self-registration), the hub owns the read side |
| **Supervision** — install, start/stop/restart, crash-restart, ports | a crashed module can't restart itself |
| **Bootstrap** — first-run wizard, first admin, first module install | exists before any module does |

**The module's domain — everything else about itself:** its daemon, its data,
its config, its **instance lifecycle** (creating/listing/deleting its own
instances — vaults, channels, surfaces, jobs), its admin/config/user surfaces,
its MCP server, its declared `events`/`actions`, its external-service
credentials.

### "The hub never renders a per-module view" — defined

A **per-module view** renders *module-domain data* fetched from the module's
own APIs (a channels list, a vault's notes, scribe's providers). The hub never
builds one — that's the hub#624 failure mode the 2026-06-09 modular-UI shift
retired.

An **identity view** renders *hub-owned tables* that happen to *name* module
instances — the Users page's per-user vault assignment, the OAuth consent
picker. Those are substrate, and they stay. The distinction is whose data and
whose API, not whether a module's name appears on screen.

(The hub SPA's Connections `CHANNEL_ADD_PRESET` is module-specific hub-SPA
code that fails this test — tracked as a holdover in the migration, to be
generalized into declaration-driven presets or retired.)

Module-specific knowledge inside hub code is otherwise either
install-bootstrap (`KNOWN_MODULES` — you can't ask an uninstalled module to
self-describe) or a tracked, transitional holdover.

## The seam — how module surfaces drive hub identity APIs

A module's surface, served same-origin behind the hub proxy, composes the
substrate with the operator's session. Four mechanisms, all live today:

1. **Cookie-gated short-lived mints.** The page loads open; its JS trades the
   operator's session cookie for a 10-min admin Bearer:
   `GET /admin/module-token/<short>` (generic, `<short>:admin`),
   `GET /admin/vault-admin-token/<name>` (per-instance vault),
   `GET /admin/host-admin-token` (host-admin authority). All
   first-admin-gated, `NON_REQUESTABLE` via public OAuth, same-origin only.
   Reference: scribe `src/admin-ui.ts` (scribe#73). The generic mint gates on
   self-registration (a services.json row whose installDir carries a readable
   `.parachute/module.json`), with the install-bootstrap registry as a fallback for
   first-party modules mid-install — so a genuinely third-party module mints
   with zero hub code changes (migration C5).
2. **Identity-transaction endpoints the surface drives with operator
   approval.** The exemplar is channel's link-a-vault: channel's own page
   POSTs the hub's `/admin/connections` (`credentials: "include"`); the hub
   mints the cross-module tokens, registers the vault trigger, records
   provenance — one operator click, the hub does every identity step.
   Provisioning endpoints (`POST /vaults`, `DELETE /vaults/<name>`) are the
   same shape: the hub orchestrates the transaction, the module's CLI/API
   does the mechanics ("the CLI is the single source of truth for how you
   create a vault" — hub `admin-vaults.ts`), and the *UX lives in the
   module's surface*.
3. **Self-registration + self-declaration.** The module writes its own
   `services.json` row at boot and describes itself in
   `.parachute/module.json` (`uiUrl`/`managementUrl`/`configUiUrl`, scopes,
   events/actions). The hub reads, never authors.
4. **Resource-server validation.** Modules validate hub JWTs against
   `/.well-known/jwks.json` + the revocation list. No module mints.

Cross-origin surfaces (the origin-free static-SPA pattern, e.g. my-vault-ui)
use the public OAuth flow instead of cookies — same substrate, different
front door.

## Lifecycle symmetry (the rule the 2026-06-09 audit added)

**Every provision flow must have a deprovision flow that cascades the
identity artifacts it created.**

**An identity artifact is any hub-DB row or unexpired signed credential that
names the instance.** Today's hub-DB columns carrying instance names:
`tokens.scopes`, `grants.scopes`, `auth_codes.scopes`,
`user_vaults.vault_name`, `invites.vault_name`, `connections` records,
`clients.scopes`. The destroy-side PR for any instance type must enumerate
this list and handle every entry — revoke the scoped tokens, rewrite or drop
the grants, drop the assignments, invalidate the pinned invites, tear down
the connections, deregister the catalog row.

Two precision notes the implementations must carry:

- **Long-lived mints must be registered.** A token minted with a TTL beyond
  the interactive class (~10 min) MUST be recorded in the hub's token
  registry — an unregistered long-lived token is *unrevocable by
  construction* (the revocation list can only carry registered jtis). The
  audit found the connections engine minting 90-day tokens unregistered;
  that is the bug class this rule exists to prevent.
- **Short-lived interactive JWTs ride to expiry by design.** The cascade
  revokes persisted rows and publishes the revocation list; a ≤10-min
  unregistered mint window is an accepted, documented bound — do not claim
  instant revocation the system doesn't make.

Mechanics deletion without identity cascade is a security hole, not a feature
gap. The audit found three live violations: vault delete (CLI-only, no
cascade at all), vault-backed-channel delete (orphaned trigger + live minted
tokens), surface DCR revocation (orphans client records on hub 404/405).
When you build a create, build the symmetric destroy in the same PR.

## The trust statement

Installing a module extends operator trust to its surfaces. A module page
served behind the proxy is **same-origin** — it can drive every cookie-gated
identity API with the operator's ambient session, and *per-module mint
restriction is impossible same-origin*: origin-wide mint authority is a
deliberate, accepted consequence of installing a module. This is coherent
with the trust gradient (an installed module already runs a daemon on your
machine, strictly more power than a cookie).

Name the active threat honestly: module surfaces render **untrusted
third-party content** (Telegram messages in channel's UI, synced notes,
transcripts). A stored XSS in any same-origin module surface escalates to
host-admin via the ambient cookie + the mint endpoints. Mitigations, each
load-bearing: the first-admin gate, 10-minute mint TTLs, `NON_REQUESTABLE`
scopes, and rigorous output escaping in every module surface. In progress,
each tracked: the CSRF belt on `/admin/*` JSON POSTs (hub#632 — Phase C1 of
the migration, sequenced first) and default CSP on proxied module pages (E8).
Do not weaken any of these to make a seam flow more convenient.

## The bootstrap exception

Pre-install and first-run flows (setup wizard, invite redemption) are
hub-owned — there is no module surface yet to defer to. They MUST consume the
same module-owned mechanics (shell out to the module CLI, call the module
API), never reimplement them. Hub `provisionVault` shelling to
`parachute-vault create --json` is the reference. The same exception covers
the **zero-instances empty state**: a hub affordance that deep-links back
into the (re-enterable) setup flow is substrate, not a per-module view.

## Known gap: per-instance identity is vault-only today

Be honest about why vault is special. Vault instances are
*identity-entangled*: per-instance scopes (`vault:<name>:<verb>`), audience
binding (`vault.<name>`), capability attenuation rules, the consent-time
vault picker, per-user instance assignment (`user_vaults`), and the
per-instance mint endpoint are all **vault-hardcoded in hub code**. There is
no generic `<short>:<instance>:<verb>` machinery.

What this means for a multi-instance module author today:

- **Instances that don't need per-instance hub scopes** (channel's channels,
  surface's apps, runner's jobs): own the lifecycle fully module-side.
  Channel is the reference — `POST/DELETE /api/channels` on the module
  daemon, `<short>:admin`-gated, zero hub involvement.
- **Instances that DO need per-instance hub scopes**: impossible without hub
  changes today. Vault is the precedent the future generic instance-scope
  API will be extracted from — tracked in the migration (E7), not promised.

## The test

A third-party **single-instance** module author ships a daemon +
`.parachute/module.json` + self-registration + their own admin surface, and
receives: proxy, discovery, OAuth scope declaration, the generic admin-token
mint, and Connections — with zero hub code changes.
Per-instance identity is the documented exception above. Any *other*
capability that fails this test is either substrate (move it behind a generic
hub API) or a holdover (move it into the module).

## Current state (2026-06-09 audit)

Conformant: channel (instance lifecycle fully module-owned; link-vault is the
seam exemplar), scribe (config UI + load-open mint), surface (DCR + tenancy
contract), runner (jobs are vault notes), vault per-vault config/tokens/mirror
(its own SPA at `/vault/<name>/admin/`).

Holdovers, tracked in
[`migrations/2026-06-09-hub-module-boundary.md`](../migrations/2026-06-09-hub-module-boundary.md):
vault **provisioning UX** in the hub SPA (the flagship move → `/vault/admin/`),
the missing **delete cascades** (all three above), unregistered long-lived
connection mints, legacy `/admin/channels` endpoint, the Connections
`CHANNEL_ADD_PRESET`, `FIRST_PARTY_FALLBACKS` residue, scribe install-time
config writes, the vault-side vestigial owner-password/TOTP the hub's
expose-preflight still reads (an *inverse* holdover: identity state living
module-side), runner's unauthenticatable config UI, surface's pasted-bearer
sign-in. (The bootstrap-registry gate on the generic mint was closed by
migration C5 — the mint now gates on self-registration.)

## Related

[`module-protocol.md`](./module-protocol.md) ·
[`module-surfaces.md`](./module-surfaces.md) ·
[`module-discovery.md`](./module-discovery.md) ·
[`module-ui-declaration.md`](./module-ui-declaration.md) ·
[`module-json-extensibility.md`](./module-json-extensibility.md) ·
[`hub-as-issuer.md`](./hub-as-issuer.md) ·
[`oauth-scopes.md`](./oauth-scopes.md) ·
[`trust-gradient-isolation.md`](./trust-gradient-isolation.md) ·
[`bootstrap-on-first-boot.md`](./bootstrap-on-first-boot.md)

## History

- **2026-04-20** — module-architecture design doc states "Hub is thin. It
  orchestrates but doesn't own module logic" but ships hub-rendered config
  forms + hub-owned provisioning (the portal era).
- **2026-06-09** — modular-UI architecture moves config UIs + discovery +
  connections to the thin shape; Aaron asks the question that names the
  boundary ("why can vault provisioning not happen inside the module? …this
  might be a pattern to deeply look at as we grow"); a 7-repo audit grounds
  this charter; a 5-lens adversarial review (10 blocking, 17 serious
  findings) hardens it — the lifecycle-symmetry definition, the registered-
  mint rule, the per-module-view definition, and the Known-gap section all
  come from that pass.
