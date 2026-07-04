> Moved from parachute-patterns/patterns/module-ui-declaration.md (2026-07-04) — see the patterns-archive decision. This repo enforces this contract.

# Module UI declaration

Services declare their UI URL in `module.json`; hub renders one
discovery tile per declaring service. URL strings resolve by **form**,
not by field: `http(s)://` = verbatim, leading-`/` = origin-absolute
verbatim, no-leading-slash = relative to the module's mount (joined
per instance for multi-instance services like vault). Semantics
unified 2026-06-09 (the hub–module boundary shift, B4 — see
[`migrations/2026-06-09-hub-module-boundary.md`](../migrations/2026-06-09-hub-module-boundary.md)).

> **Status: adopted.** Data-driven discovery shipped in hub#288 and
> the consumer-side `uiUrl` reader (`loadServiceUiMetadata`) landed
> with it. The earlier hardcoded `SERVICE_LABELS` map retired; the
> remaining hardcoded surface is the "Browse Vault" tile in the
> Get-started section of [`parachute-hub/src/hub.ts`](https://github.com/ParachuteComputer/parachute-hub/blob/main/src/hub.ts),
> which workstream C (UX audit §5 row C, 2026-05-25) retires once
> vault and scribe declare `uiUrl` in their `module.json` files.

## Use vs admin — both can be true

The earlier framing of this doc said "vault has no `uiUrl` because
vault content is browsed via Notes." That framing collapsed two
different audiences into one decision. They split cleanly:

- **End users** browse vault data via Notes. Notes is the user-facing
  surface; vault is the storage backend Notes reads from.
- **Operators** administer the vault via vault's own surfaces:
  per-instance config / tokens / mirror / inspection at
  `/vault/<name>/admin/`, and instance *provisioning* (create / delete
  vaults) at the daemon-level `/vault/admin/`. The provisioning UX is
  module-owned; only the provisioning *transaction* (`POST /vaults` /
  `DELETE /vaults/<name>`, host-admin-gated) is the hub's — per
  [`hub-module-boundary.md`](./hub-module-boundary.md).

`uiUrl` points operators at the admin SPA. It is not content
browsing. The Notes tile (Notes' own `uiUrl`) covers the end-user
surface; the vault tile covers the operator surface. Both belong on
discovery; they're complementary, not duplicative.

The Circle 1 conformance band ([design-system.md §8](./design-system.md#8-where-this-applies))
explicitly names `/vault/<name>/admin/*` and `/scribe/admin` as
admin-chrome surfaces — they exist, they're maintained, they're part
of the Parachute brand surface, and they deserve a discovery tile of
their own.

## Convention

Every committed-core module that has an admin or user-facing UI
**declares its UI URL in `module.json`** as a top-level optional
field:

```json
{
  "name": "parachute-notes",
  "uiUrl": "/notes",
  "displayName": "Notes",
  "tagline": "Browse your vault content."
}
```

The hub's discovery page reads `uiUrl` (via the well-known doc) and
renders one tile per declaring service — `displayName` as the title,
`tagline` as the description, `uiUrl` as the link target. Modules that
omit `uiUrl` are still registered (still appear in
`/.well-known/parachute.json`, still routable for API consumers); they
just don't render a clickable card on discovery.

### Multi-instance services (vault)

Vault runs N instances behind one backend (`/vault/default`,
`/vault/techne`, …). A **relative** (no leading slash) `uiUrl` /
`managementUrl` is the per-instance form: hub joins it onto each
instance's mount path when building well-known rows. A **leading-`/`**
URL is origin-absolute and passes through verbatim — vault uses that
form for its daemon-level multi-vault home.

```json
{
  "name": "parachute-vault",
  "uiUrl": "admin/",
  "managementUrl": "admin/",
  "configUiUrl": "/vault/admin/",
  "paths": ["/vault/default"]
}
```

For a vault mounted at `/vault/default`, hub emits one services row
per instance with `uiUrl: "/vault/default/admin/"` (the relative
`"admin/"` joined onto the instance mount). For a vault with paths
`["/vault/default", "/vault/techne"]`, hub emits two rows, each with
its own `uiUrl`. Discovery renders one tile per instance; operators
running multiple vaults see them all. The origin-absolute
`configUiUrl: "/vault/admin/"` emits **once** (not per instance) —
it names the daemon-level surface where vaults are created / deleted
(see [`hub-module-boundary.md`](./hub-module-boundary.md)).

Single-instance services (scribe, notes, app) typically declare the
origin-absolute form (scribe's `uiUrl: "/scribe/admin"` resolves
verbatim); a relative form would join their single mount and resolve
to the same place.

## Shape

```ts
uiUrl?: string;  // http(s) URL, origin-absolute path, or mount-relative path
```

Resolution rules — **B4 canonical semantics, 2026-06-09** (one rule
set shared by `uiUrl`, `managementUrl`, and `configUiUrl`; resolution
is decided by the *form of the string*, not by which field carries it):

- **Absolute URL** — `"https://notes.example.com"`. Used verbatim, no
  joining. The escape hatch for UIs hosted off the hub origin.
- **Origin-absolute path (leading `/`)** — `"/notes"`, `"/scribe/admin"`,
  `"/vault/admin/"`. Used **verbatim against the canonical origin**
  (the hub origin, which proxied modules share). Never mount-prefixed.
  This is how a multi-instance module names a daemon-level surface
  that exists once, not per instance.
- **Relative path (no leading `/`)** — `"admin/"`. Joined to the
  module's mount path. For multi-instance modules (vault), joined
  **per instance** during well-known fan-out:
  `/vault/<name>/` + `"admin/"` → `/vault/<name>/admin/`, one row per
  instance. For single-instance modules the join degenerates to
  `<mount>/<path>`.
- **Omitted** — no tile rendered. Use this for API-only services
  (no admin UI shipped yet) or services whose UI is only reachable
  via another module.

**Resolver contract.** The hub's `resolveManagementUrl` family
(`hub-server.ts`, `account-vault-admin-token.ts`,
`web/ui/src/lib/api.ts`; `hub.ts` `loadServiceUiMetadata` is a fourth
consumer) treats its inputs as **per-instance-relative by contract**:
a relative string on a multi-instance module always resolves against
the specific instance the link is rendered for. `buildWellKnown` and
`resolveModuleUrl` apply the same three-form rules.

**Compat shim (one release).** Before 2026-06-09, vault's manifest
declared the *literal* `"/admin/"` and the hub mount-joined it despite
the leading slash. For one release, a literal `"/admin/"` on a **vault**
entry still mount-joins, with a deprecation warning; the shim is
removed once vault's new manifest (`"admin/"` + `configUiUrl:
"/vault/admin/"`) reaches `@latest`. Old-hub + new-vault skew is a
known cosmetic 404 (links only, no auth impact). See
[`migrations/2026-06-09-hub-module-boundary.md`](../migrations/2026-06-09-hub-module-boundary.md)
(B4).

Trailing slash: SPA surfaces that expect one (vault's admin) should
declare it (`"admin/"`, `"/vault/admin/"`) — see the fragment-token
rationale in
[`module-json-extensibility.md`](./module-json-extensibility.md#managementurl-string).

The hub picks `displayName` and `tagline` for the tile from the same
`module.json` fields it already reads
([`module-json-extensibility.md` — Shape](./module-json-extensibility.md#shape))
— no separate per-discovery-tile copy.

## Why

- **Discovery is no longer hub-side knowledge.** Hub doesn't ship a
  hardcoded list of "which services have UIs and what they're called."
  Adding a new service ships a new tile when its `module.json`
  declares one.
- **The use-vs-admin distinction stops mattering at the hub layer.**
  The first cut at the discovery section split tiles into "Use" and
  "Admin"; that broke down because real service UIs mix use, config,
  and admin together (Notes is also where you administer Notes; Agent
  has run + admin in one SPA). Services declare what their UI *is* —
  combining concerns however they want — and hub renders one link.
  See the rationale comment at the top of
  [`parachute-hub/src/hub.ts`](https://github.com/ParachuteComputer/parachute-hub/blob/main/src/hub.ts).
- **Author-controlled.** A third-party module that ships a `uiUrl` in
  its `module.json` lights up on the hub's discovery page on install
  with no hub-side change.
- **Backwards-compatible.** Absent field = no tile. Existing
  `module.json` files stay valid unchanged.

## Relationship to `managementUrl`

`managementUrl` (added 2026-05-02, see
[`module-json-extensibility.md` — Hub UI fields](./module-json-extensibility.md#managementurl-string))
already exists as an admin-specific link for hub-owned admin pages —
specifically, the hub's vault-management SPA renders a
"Manage `<displayName>`" link per vault instance pointing at
the per-instance join of the relative `managementUrl` onto the
instance mount (`/vault/<name>/` + `"admin/"` — the B4 relative
form). That covers the case where hub admin
pages need to link out to per-instance module admin UIs.

`uiUrl` is its discovery-side peer:

| Field | Surface | Renders | Cardinality |
| --- | --- | --- | --- |
| `uiUrl` | Hub discovery page | One tile per service | Per service (or per-instance if a service runs multiple) |
| `managementUrl` | Hub admin pages (e.g., vault list) | "Manage `<name>`" link per instance | Per instance |

A service may declare both (e.g., a future combined notes admin SPA
under `/notes` declares both `uiUrl: "/notes"` and `managementUrl:
"/notes/admin"`), one, or neither. They serve different surfaces and
don't conflict.

## `configUiUrl` — the module's own config surface (2026-06-09)

The **[modular-UI architecture](../design/2026-06-09-modular-ui-architecture.md)**
shift adds a third UI-declaration field: `configUiUrl`. It completes the
trio by naming **where the module's own config surface lives** — the surface
the hub frames / links from a uniform config shell, instead of hard-coding a
per-module config view in the hub SPA (the deprecated generic `ModuleConfig`
form, and the bespoke per-module Channels view, were the anti-pattern this
retires).

The three fields divide cleanly by audience and surface:

| Field | Surface | Renders | Resolution |
| --- | --- | --- | --- |
| `uiUrl` | Hub **discovery** page | One **tile** per service (the user-facing UI) | shared B4 rules (§Resolution rules) |
| `managementUrl` | Hub **admin** pages | "Manage `<name>`" **deep-link** per instance | shared B4 rules |
| `configUiUrl` | Hub **config shell** | The module's **own config surface** (hub frames / links it) | shared B4 rules |

The fields differ by the **surface they're rendered on**, not by how
their strings resolve — resolution is one rule set, decided by the form
of the string (§Resolution rules above).

```ts
configUiUrl?: string;  // path or full URL — the module's own config surface
```

- **uiUrl = the discovery tile.** "Here's the thing; go use it."
- **managementUrl = an admin deep-link.** "Manage this instance" from a
  hub admin list (today: the per-vault list).
- **configUiUrl = the module's own config surface.** The hub renders one
  consistent config shell and frames / links each module's `configUiUrl`;
  the module owns the config UI end-to-end. This is the machine-readable
  form of the "modules own their config UIs" principle. Resolution follows
  the shared B4 rules (§Resolution rules: `http(s)://` verbatim ·
  leading-`/` origin-absolute verbatim · no-leading-slash mount-joined).

A module may declare any subset. Examples from the modular-UI arc:

- **scribe** — `uiUrl: "/scribe/admin"` (discovery tile) and
  `configUiUrl: "/scribe/admin"` may point at the same self-served surface;
  scribe's admin HTML *is* its config UI. Both strings are leading-`/`
  origin-absolute, so they resolve to the same URL by the same rule. A
  module whose config UI is hosted off the hub origin uses the full
  `http(s)://` form.
- **channel** — builds + serves a config/admin UI (manage channels /
  transports) and declares `configUiUrl` for it (`focus: "experimental"`).
- **runner** — builds + serves a job-listing / config UI and declares
  `configUiUrl`.

Full field catalog + the `focus` / `events` / `actions` peers:
[`module-json-extensibility.md` — Modular-UI fields](./module-json-extensibility.md#modular-ui-fields).
The discovery-side `focus` tier (self-registration, no whitelist) is in
[`module-discovery.md`](./module-discovery.md).

## Examples

- **`parachute-notes`** — declares `uiUrl: "/notes"`. The Notes PWA is
  the module's UI. Hub discovery renders a Notes tile. No
  `managementUrl` (admin and use are the same surface).
- **`parachute-surface`** — declares `uiUrl: "/surface/admin/"` for the
  app-admin SPA (managing bundled UIs); the PWA apps like Notes are
  separately surfaced via their own modules' `uiUrl`.
- **`parachute-scribe`** — declares `uiUrl: "/scribe/admin"`. The
  server-rendered admin page (`src/admin-ui.ts`) is the operator
  surface — config form, provider status, credential clearing. No
  `managementUrl` (single-instance, no hub-side vault-list surface).
- **`parachute-vault`** — declares `uiUrl: "admin/"` and
  `managementUrl: "admin/"` (relative form → joined per instance,
  producing one tile / one "Manage" link per vault at
  `/vault/<name>/admin/`), plus `configUiUrl: "/vault/admin/"`
  (origin-absolute → the daemon-level multi-vault home where instances
  are created / deleted; emitted once, not per instance). The earlier
  "vault content is browsed via Notes — no tile" rule is retired: Notes
  covers the end-user surface; vault's own surfaces cover the operator
  surface (per-vault tokens, config, MCP at `/vault/<name>/admin/`;
  provisioning at `/vault/admin/` per
  [`hub-module-boundary.md`](./hub-module-boundary.md)).

## Rules

- **The leading slash is load-bearing.** `"/scribe/admin"` is
  origin-absolute (verbatim); `"admin/"` is mount-relative (joined per
  instance for multi-instance modules). Don't write `"/admin/"` when
  you mean "this module's admin, under its mount" — that is the
  pre-2026-06-09 ambiguity the B4 unification retired (a one-release
  compat shim mount-joins the legacy literal on vault entries, with a
  deprecation warning). Include the trailing slash where the target
  SPA expects it. No other normalization.
- **`uiUrl` is for the hub discovery page.** Don't hand-jam admin-only
  paths in here when the user-facing UI is what belongs on discovery —
  that's what `managementUrl` is for. If a service has only an admin
  UI and no public-facing surface, declaring it as `uiUrl` is fine
  (Agent's UI is admin-flavored and ships there); the rule is about
  framing, not gating.
- **Hub doesn't sniff or parse the link target.** `uiUrl` is opaque to
  hub. Auth, anonymous-access policy, and what's behind the link are
  the module's concern.
- **Display copy comes from `displayName` + `tagline`.** No separate
  `uiTitle` / `uiDesc` field. If the module wants different copy on
  discovery vs. elsewhere, that's a (rejected for now) signal of
  YAGNI splintering.

## Adoption sequencing

Standard parallel-cross-repo shape (see
[`parallel-cross-repo-PRs.md`](./parallel-cross-repo-PRs.md)):

1. **Patterns** — define the convention (this doc).
2. **Module `module.json` updates (one PR per module)** —
   `parachute-notes` declares `uiUrl: "/notes"`,
   `parachute-surface` declares `uiUrl: "/surface/admin/"`,
   `parachute-scribe` declares `uiUrl: "/scribe/admin"`,
   `parachute-vault` declares `uiUrl: "admin/"` (relative per-instance
   form; B4 semantics).
   Each module ships its updated `module.json` inside its npm artifact.
3. **Hub consumer-side update** — well-known doc carries `uiUrl`
   through; discovery page (`hub.ts`) reads `uiUrl` from
   `/.well-known/parachute.json` and renders one tile per declaring
   service. The hardcoded `SERVICE_LABELS` / `SERVICE_ORDER` arrays
   and the `isVaultName` filter retired in hub#288. The hardcoded
   "Browse Vault" Get-started tile (added in hub#342 as a stopgap)
   retires under workstream C once vault declares `uiUrl` and hub
   reads it for vault entries (the current `loadServiceUiMetadata`
   skips vault rows; lift that skip and have `buildWellKnown` join
   the declared relative `uiUrl` onto each instance's mount path per
   the B4 rules).
   Tile order: stable by service `displayName` alphabetical (or by
   an explicit `displayOrder` field if a need for explicit ordering
   surfaces — defer until two services actually conflict on natural
   order).

Steps 2 and 3 are backwards-compatible with each other: hub before
step 3 ignores the new field; modules before step 2 simply don't
appear (same behavior as today's omission). They can land in either
order.

## Open questions

- **Auth requirements metadata.** Should `uiUrl` carry whether the UI
  supports anonymous access vs. requires sign-in? Useful for hub to
  hint "Sign in to use Agent" vs. "Open Notes" on the tile. Defer
  until hub discovery actually wants to differentiate; today's "sign
  in to hub, then click anything" flow doesn't need it.
- **`displayOrder` for explicit ordering.** The current hardcoded
  order (`notes`, `scribe`, `agent`) reflects Aaron's preferred
  prominence; alphabetical by name happens to give the same result
  for these three. If a service named `aardvark` later wanted
  bottom-of-list placement, an explicit numeric `displayOrder` (lower
  = earlier) is the obvious knob. Defer.
- **Tile shape beyond a single link.** Today the tile is the only
  render shape; if a module ever wants a launch-button or a richer
  card, the decision is driven by whether the module declares
  `uiUrl` (discovery tile), `managementUrl` (admin link), or both.
  Defer until a real use case lands.

## Where this applies

- **Today (committed-core):**
  - `parachute-notes` — `uiUrl: "/notes"`.
  - `parachute-surface` — `uiUrl: "/surface/admin/"`.
  - `parachute-scribe` — `uiUrl: "/scribe/admin"` (workstream C).
  - `parachute-vault` — `uiUrl: "admin/"` (relative per-instance form)
    + `configUiUrl: "/vault/admin/"` (origin-absolute daemon-level home).
- **Later:** any first- or third-party module that ships a UI under
  the hub origin. Same field, same shape.
- **Not in scope:** services with truly no operator-facing UI simply
  omit the field. No committed-core module is in this bucket today —
  every module has at least an admin surface to declare.
