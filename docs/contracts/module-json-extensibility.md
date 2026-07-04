> Moved from parachute-patterns/patterns/module-json-extensibility.md (2026-07-04) — see the patterns-archive decision. This repo enforces this contract.

# Module JSON extensibility

> **Note (2026-05-23):** The `kind` field has been removed from the canonical
> manifest shape ([hub#327](https://github.com/ParachuteComputer/parachute-hub/pull/327)
> made it optional; [hub#330](https://github.com/ParachuteComputer/parachute-hub/issues/330)
> completes the retirement). Hub doesn't branch on kind anymore; capabilities
> are explicit (`paths`, `health`, `managementUrl`, `uiUrl`). See
> [`module-surfaces.md`](./module-surfaces.md) for the canonical framing.

> **Status: target convention, partial implementation.** The shape is
> declared in
> [`parachute.computer/design/2026-04-20-module-architecture.md`](https://github.com/ParachuteComputer/parachute.computer/blob/main/design/2026-04-20-module-architecture.md#extensibility-path)
> and committed to as the third-party path. The CLI's
> `parachute install` does not yet read `.parachute/module.json` —
> today it falls back to a hardcoded `SERVICE_SPECS` table in
> [`parachute-hub/src/service-spec.ts`](https://github.com/ParachuteComputer/parachute-hub/blob/main/src/service-spec.ts).
> That hardcoding is a **first-party shortcut, not an architectural
> limit**. This pattern doc nails the contract so third-party authors
> and the eventual CLI implementation agree on the shape.

## Convention

A Parachute module is identified by its **contracts**, not by its
package name. A third-party module declares itself by shipping a
`.parachute/module.json` file in the published npm package; the CLI
reads it on `parachute install <package>` and treats the package as
first-class. **No `@openparachute/` scope, no `parachute-*` prefix
required.**

The `module.json` is the canonical, machine-readable self-description.
Everything the CLI needs to install and run the module — and
everything the hub needs to render and route to it — lives in this
one file the author controls.

## Shape

```json
{
  "name": "my-service",
  "manifestName": "my-service",
  "displayName": "My Service",
  "tagline": "What the service does",
  "port": 7001,
  "paths": ["/my-service"],
  "health": "/health",
  "hasAuth": true,
  "startCmd": ["bin/my-service", "serve"],
  "init": { "command": ["my-service", "init"] },
  "urlForEntry": {
    "perConsumer": {
      "claude.ai": { "appendPath": "/mcp" }
    }
  },
  "managementUrl": "admin",
  "scopes": { "defines": ["my-service:read", "my-service:write"] },
  "dependencies": {
    "vault": { "optional": true, "scopes": ["vault:read"] }
  }
}
```

| Field | Meaning |
| --- | --- |
| `name` | Stable, unique identifier across the ecosystem. Becomes the `services.json` key, the scope namespace, the `parachute start <name>` token. Must match `[a-z][a-z0-9-]*`. |
| `manifestName` | The name used in user-facing manifests (PWA / OAuth client name). Often equals `name`. |
| `displayName` | Human label rendered on the hub card. |
| `tagline` | One-line description rendered under `displayName`. |
| `port` | Default loopback port. Pick outside the reserved Parachute range (`1939–1949`) — see [`canonical-ports.md`](./canonical-ports.md). The CLI warns on collision but does not block. |
| `paths` | URL paths the module serves under the hub origin. |
| `health` | Path for liveness probes. |
| `hasAuth` | `true` if the module is itself an OAuth resource server (gates its own endpoints behind auth). Drives default public-exposure policy and tunnel/funnel treatment. Optional; defaults to `false`. See [Install-time behaviors](#install-time-behaviors) below. |
| `startCmd` | Argv the CLI invokes for `parachute start <name>`. Resolved relative to the installed package. |
| `init` | Optional post-install one-shot the CLI runs after `parachute install <name>`. Object with a `command` argv. Safety: first arg must equal a bin defined by the installed npm package. See [Install-time behaviors](#install-time-behaviors). |
| `urlForEntry` | Optional declarative URL adjustments keyed by consumer. Today's only operations: `appendPath` (append a suffix) or `replaceWith` (full override). See [Install-time behaviors](#install-time-behaviors). |
| `managementUrl` | Optional path-or-full-URL where the module's admin UI lives. Hub renders a "Manage" link when present. See [Hub UI fields](#hub-ui-fields). |
| `configUiUrl` | Optional path-or-full-URL where the **module's own config surface** lives. The hub frames / links it from a uniform config shell — it never hard-codes a per-module config view. See [Modular-UI fields](#modular-ui-fields). |
| `focus` | Optional discovery tier — `"core"` or `"experimental"`. De-emphasizes (never hides) exploration modules on the Modules screen. Unlisted defaults to `"experimental"`. See [Modular-UI fields](#modular-ui-fields). |
| `configSchema` | Optional JSON Schema for declarative config (promotes the existing-but-unused `/.parachute/config/schema` field into the manifest). See [Modular-UI fields](#modular-ui-fields). |
| `adminCapabilities` | Optional `string[]` metadata advertising admin facets (e.g. `["config","credentials","logs"]`). See [Modular-UI fields](#modular-ui-fields). |
| `events` | Optional array of `{key,title,filterSchema?}` describing the events this module **emits** — the source half of a Connection. See [Modular-UI fields](#modular-ui-fields). |
| `actions` | Optional array of `{key,title,inputSchema?,provision?}` describing the actions this module **accepts** — the sink half of a Connection. See [Modular-UI fields](#modular-ui-fields). |
| `scopes.defines` | OAuth scopes the module owns. Namespaced by `name` so collisions don't happen — see [`oauth-scopes.md`](./oauth-scopes.md). |
| `dependencies` | Other modules this one wants to talk to. Each entry has `optional` and `scopes` fields; CLI uses these to auto-wire on install (env-var injection) — see [`service-to-service-auth.md`](./service-to-service-auth.md). |

## Install-time behaviors

`hasAuth`, `init`, and `urlForEntry` were added 2026-04-30 (parachute-hub#100)
to close the gap between `module.json` and the hub's transitional
`FIRST_PARTY_FALLBACKS` extras block. Aaron's call: **path 1 — extend the
schema — over path 2 — codify a permanent extras lane.** Rationale: extras
exists only for first-party modules and is meant to retire; if a behavior
is real enough to ship in vault, it's real enough to be declarable by any
module. All three fields are optional and missing defaults to "no" /
"none", so existing manifests are valid unchanged.

### `hasAuth: boolean`

```ts
hasAuth?: boolean;  // default false
```

Declares the module as an OAuth resource server — i.e., it validates
bearer tokens on its own endpoints. The hub uses this to derive
`publicExposure`'s default: with `hasAuth: true` the module defaults to
`"allowed"` (safe to expose because the module gates itself); without it
the module defaults to `"auth-required"` (the module hasn't claimed
auth, so non-loopback layers are gated by hub on its behalf). It also
informs how `parachute expose` and the discovery surface treat
bearer-bearing modules.

#### Runtime behavior — hub-side per-request layer-gate

`publicExposure` is enforced **per request, in hub**, not at expose
time. Every reverse-proxied request is tagged with the layer it
arrived on — `loopback` (127.0.0.1), `tailnet` (Tailscale), or
`public` (Cloudflare Tunnel / Funnel) — and hub consults the target
service's `publicExposure` value to decide whether to proxy or 404.
The expose surface (tailnet, public) is collapsed to a single hub
catchall; per-service expose toggles do not exist as independent
state anymore. See [parachute-hub#187](https://github.com/ParachuteComputer/parachute-hub/pull/187)
for the implementing change (2026-05-08).

Access matrix:

| `publicExposure` | Loopback | Tailnet | Public | Gated by |
| --- | --- | --- | --- | --- |
| `"allowed"` | reaches | reaches | reaches | service's own auth (none required by hub) |
| `"loopback"` | reaches | 404 | 404 | hub layer-gate (the service never sees the request) |
| `"auth-required"` | reaches | reaches | reaches | service's own auth (same gate behavior as `"allowed"`; the value documents "I have auth and I'm enforcing it" vs. `"allowed"`'s "no opinion / open") |

Concretely: `"loopback"` is the only value that withholds traffic
from non-loopback layers. `"allowed"` and `"auth-required"` produce
identical hub behavior — the difference is documentary: `"allowed"`
asserts the service is intentionally open or has no sensitive
surface; `"auth-required"` asserts the service is enforcing auth on
its own endpoints. Hub forwards in both cases and trusts the service
to handle authn/z.

Trivially declarative — the value doesn't change at runtime. If a
module's auth gate is conditional on a config flag (e.g., scribe with /
without `SCRIBE_AUTH_TOKEN`), declare the conservative default here and
let the runtime overwrite via an explicit `publicExposure` write to its
`services.json` row when configuration confirms auth is on.

### `init: { command: [string, ...string[]] }`

```ts
init?: {
  command: readonly [string, ...string[]];  // non-empty argv
};
```

Post-install one-shot the CLI runs once after `parachute install <name>`
completes. Used today by vault to seed its data directory:

```json
{ "init": { "command": ["parachute-vault", "init"] } }
```

**Safety constraint (mandatory).** The first arg of `command` MUST equal
a bin name declared by the installed npm package (resolved at install
time via the package's `package.json` `bin` field). The hub rejects the
manifest at install time otherwise. This rules out things like:

```json
{ "init": { "command": ["rm", "-rf", "/"] } }   // REJECTED at install time
{ "init": { "command": ["curl", "evil.example"] } }  // REJECTED
```

The constraint is structural, not advisory. It means a malicious or
broken `module.json` cannot trick the CLI into invoking arbitrary
binaries on the user's `$PATH` — the only thing `init` can run is the
package's own published code. Subsequent args (after the bin name) are
passed through verbatim and are the module's own concern.

**Failure mode.** If the init command exits non-zero, `parachute install`
fails hard and surfaces the exit code + stderr. No retries, no silent
continue — partial-init state is the kind of bug that's worse to mask
than to surface.

**Idempotency is the module's responsibility.** The CLI runs `init` once
per `parachute install` invocation; modules whose init touches durable
state should make repeated runs safe (e.g., vault's `init` is a no-op if
the data directory already exists).

### `urlForEntry.perConsumer`

```ts
urlForEntry?: {
  perConsumer: {
    // exactly one of appendPath or replaceWith per consumer entry
    [consumerId: string]: {
      appendPath?: string;   // suffix appended to the canonical URL
      replaceWith?: string;  // full URL override (escape hatch)
    };
  };
};
```

Declarative URL adjustments for specific consumers. Replaces the
`urlForEntry: (entry) => string` JS callback the hub's `VAULT_FALLBACK`
carries today.

The canonical URL for a service is `http://127.0.0.1:<port><paths[0]>`
(with trailing slashes stripped). Most clients hit that URL directly.
A few well-known consumers need an adjustment because their conventions
diverge — today's only real case is claude.ai, which expects vault's MCP
endpoint at `<base>/mcp` rather than the bare mount path:

```json
{
  "urlForEntry": {
    "perConsumer": {
      "claude.ai": { "appendPath": "/mcp" }
    }
  }
}
```

**Operations (exactly one per consumer entry).**

- `appendPath`: string suffix concatenated to the canonical URL after
  trailing-slash normalization. Most common case.
- `replaceWith`: full absolute URL replacing the canonical one entirely.
  Escape hatch for services whose endpoint isn't path-derivable from the
  module's mount (e.g., scribe today serves at the bare port root, not
  under `/scribe`).

Specifying both is a validation error. Specifying neither is a
validation error.

**Consumer-id resolution.** The `consumerId` key is matched against a
list of well-known consumer IDs the hub curates (e.g., `claude.ai`,
`chatgpt.com`). The hub publishes the list at `/.parachute/consumers`
(target — not yet shipped); for now, treat the list as the union of
consumers any first-party module references. Unknown consumer IDs in a
manifest are validated for shape but ignored at lookup time — they
become live the moment the hub adds their definition. The lookup is
exact-match on the consumer ID string; no regex or template
substitution at v1.

**Why no template / regex / per-request logic.** YAGNI. The vault
`urlForEntry` callback the hub ships today is a closure over a single
constant `/mcp` suffix; a regex lookup table is more complexity than the
problem warrants. Re-evaluate if a third consumer needs a non-`appendPath`
shape that doesn't reduce to `replaceWith`.

## Hub UI fields

Render-time fields the hub reads from a module's `module.json` (surfaced
via the module's well-known doc) to shape its directory page. Optional;
absent means "the hub renders nothing for this concern" — existing
manifests stay valid unchanged.

For the discovery-side peer field `uiUrl` — declaring where a module's
user-facing UI lives, rendered as a tile on hub's discovery page — see
[`module-ui-declaration.md`](./module-ui-declaration.md). Since the
2026-06-09 B4 unification, `uiUrl` / `managementUrl` / `configUiUrl`
all share **one resolution rule set**, decided by the form of the
string (see below) — there is no longer a per-field resolution base.

### `managementUrl: string`

```ts
managementUrl?: string;  // path or full URL
```

Where the module's admin UI lives. The hub reads this from the module's
well-known doc and renders a "Manage <displayName>" link on its
directory page. Added 2026-05-02 alongside the hub vault-management SPA
work (parachute-hub#158, parachute-vault#216).

**Resolution** — B4 canonical semantics (2026-06-09, the hub–module
boundary shift; shared with `uiUrl` and `configUiUrl` — see
[`module-ui-declaration.md`](./module-ui-declaration.md#shape)):

- **Full absolute URL** (e.g., `"https://admin.example.com"`): hub uses
  verbatim. Escape hatch for modules whose admin UI is hosted somewhere
  other than the hub origin.
- **Origin-absolute path** (leading `/`, e.g., `"/vault/admin/"`): hub
  uses verbatim against the canonical origin — never mount-joined. This
  is how a multi-instance module names a daemon-level surface that
  exists once, not per instance.
- **Relative path** (no leading `/`, e.g., `"admin/"`): hub joins it to
  the module's mount — `<module-url>/admin/`. For multi-instance
  modules (vault) the join happens **per instance**:
  `/vault/<name>/admin/`, one resolved URL per instance. The hub's
  `resolveManagementUrl` family treats its inputs as
  per-instance-relative by contract.

The pre-B4 doc said a leading-`/` path like `"/admin"` resolved against
the module's well-known origin — that mount-joining of a leading-`/`
string is retired. **Compat shim (one release):** the literal legacy
`"/admin/"` on a *vault* entry still mount-joins, with a deprecation
warning, until vault's new manifest (`managementUrl: "admin/"`) reaches
`@latest`. See
[`migrations/2026-06-09-hub-module-boundary.md`](../migrations/2026-06-09-hub-module-boundary.md)
(B4).

**Auth seam.** The module's UI handles its own auth — typically a
hub-issued JWT scoped narrowly to that module (e.g., a vault-admin scope
for vault's SPA). The hub doesn't proxy module internals or sniff auth
headers; it links out and the module's own SPA boots up under its
origin and runs its own OAuth dance against the hub if it needs one.

**Trailing slash for fragment-token SPAs.** For SPA-style admin UIs
that receive auth tokens via URL fragment (e.g., `#token=…`), the
`managementUrl` SHOULD end with `/`. Browsers drop URL fragments
through 301 redirects (RFC 7231 SHOULD-preserves, but
Chrome/Firefox/Safari behave inconsistently — most drop). If the
module's server canonicalizes bare → trailing-slash form via 301,
the fragment is silently lost and the SPA receives no token. By
emitting the canonical trailing-slash form directly from
`managementUrl`, the redirect never fires and the token survives.
Real-world example: vault#252 added a 301 from `/vault/<name>/admin`
→ `/vault/<name>/admin/`; vault#255 fixed token loss by changing
`managementUrl: "/admin"` → `"/admin/"` (pre-B4 legacy forms — the
current per-instance form is `"admin/"`). Modules with non-SPA
admin UIs, or SPAs that don't use fragment-tokens, don't need this.

**Backwards-compatible.** Absent field = no link rendered. Modules that
manage purely via CLI, or have no admin surface at all, simply omit the
field. Same rule as `hasAuth` / `init` / `urlForEntry`.

**Why this lives with the module, not the hub.** Per-module admin UIs
need to render module-internal API shapes — vault's name list, scribe's
job queue, parachute-agent's bot wiring. Putting the UI in the hub leaks those
shapes into the portal and breaks the modular contract. Putting it
under the module's own origin keeps the boundary clean: hub stays a
thin directory + link-out; each module owns its admin surface
end-to-end. Decision recorded 2026-05-02 (Aaron's call) after an
initial pass at hub-side per-vault detail pages was reverted.

## Modular-UI fields

Added 2026-06-09 by the **modular-UI architecture** shift (design doc:
[`../design/2026-06-09-modular-ui-architecture.md`](../design/2026-06-09-modular-ui-architecture.md);
migration: [`../migrations/2026-06-09-modular-ui.md`](../migrations/2026-06-09-modular-ui.md)).
The shift splits three conflated concerns — **discovery** (hub-owned, driven
by self-registration), **a module's own config UI** (module-owned, hub-framed),
and **connections** (hub-native, cross-module wiring) — and gives each a
machine-readable contract here. All six fields are optional and additive;
existing manifests stay valid unchanged.

### `focus: "core" | "experimental"`

```ts
focus?: "core" | "experimental";  // default "experimental" for unlisted
```

Discovery tier. The hub's Modules screen enumerates **every self-registered
module** (`services.json` ∪ `module.json` ∪ supervisor — no whitelist; see
[`module-discovery.md`](./module-discovery.md)) and uses `focus` to sort and
label rather than to gate: `"core"` modules surface first; `"experimental"`
ones are de-emphasized but **never hidden**. This is what lets a running,
self-registered module (e.g. agent) be administratively visible without an
entry in a curated constant. Absent → treated as `"experimental"`.

### `configUiUrl: string`

```ts
configUiUrl?: string;  // path or full URL — the module's OWN config surface
```

Where the **module's own** config/admin surface lives. The hub renders a
uniform config shell that links to / frames this URL; it never grows a
bespoke per-module config view in its SPA. This is the machine-readable
form of the "modules own their config UIs" principle.

`configUiUrl` is distinct from `managementUrl` and `uiUrl`:

| Field | Surface | Meaning |
| --- | --- | --- |
| `uiUrl` | Hub discovery page | The discovery **tile** — where the module's user-facing UI lives. |
| `managementUrl` | Hub admin pages (e.g. vault list) | An admin **deep-link** — "Manage `<name>`" per instance. |
| `configUiUrl` | Hub config shell | The module's **own config surface** the hub frames / links. |

Resolution follows the shared B4 rules (see
[`managementUrl`](#managementurl-string) above: `http(s)://` verbatim ·
leading-`/` origin-absolute verbatim · no-leading-slash joined to the
module's mount). Vault uses the origin-absolute form here —
`configUiUrl: "/vault/admin/"`, the daemon-level multi-vault home. See
[`module-ui-declaration.md`](./module-ui-declaration.md) for the full
three-way comparison.

### `configSchema: { /* JSON Schema */ }`

```ts
configSchema?: object;  // JSON Schema
```

Promotes the existing-but-unused `/.parachute/config/schema` runtime endpoint
(see [`module-protocol.md`](./module-protocol.md) §2) into the install-time
manifest. Declarative config a consumer can render without round-tripping to
the running module. Optional; a module with a custom `configUiUrl` surface
needn't declare it.

### `adminCapabilities: string[]`

```ts
adminCapabilities?: string[];  // e.g. ["config","credentials","logs"]
```

Free-form metadata advertising which admin facets a module's config surface
covers. Hint-only — the hub may use it to label the config shell. No fixed
vocabulary at v1.

### `events` + `actions` — the Connections contract

```ts
events?:  Array<{ key: string; title: string; filterSchema?: object }>;
actions?: Array<{
  key: string;
  title: string;
  inputSchema?: object;
  provision?: object;   // how the hub wires this action (e.g. register a vault trigger)
}>;
```

The declarative surface for **hub-native connections** — wiring "when
[event] in [module] → do [action] in [module]". A module declares the
`events` it **emits** (the source half) and the `actions` it **accepts**
(the sink half). The hub — the only thing with cross-module authority to
mint tokens and register triggers — owns a general Connections surface that
reads these declarations and orchestrates provisioning via each action's
`provision` block. No per-module-pair hard-coding.

A connection's right-hand **sink is always an `action`** (something a module
*accepts*), never an `event` (something a module *emits*). Keep the two halves
straight — an event can only ever be a connection's *source*.

First-class declarations the committed-core modules ship:

- **vault** emits `note.created` / `note.updated` / `note.deleted`; accepts `note.create`.
- **scribe** emits `transcription.complete`; accepts `transcribe`.
- **agent** (ex-channel) emits `message.received` / `message.sent`; accepts `message.deliver`.

"Add a vault-backed agent" becomes the connection
`vault.note.created (filter: tag agent/message/inbound) →
agent.message.deliver` — a general Connection, not agent-specific config.
The sink is the agent **action** `message.deliver` ("Deliver an inbound
message (wakes the session)"); its `provision` block tells the hub to register
a vault runtime trigger (vault#469) that webhooks the agent's inbound
endpoint with a hub-minted `agent:send` bearer. The agent `message.received`
/ `message.sent` **events** are the *source* half for *other* connections that
want to react to agent activity — they are never the inbound sink.
`filterSchema` shapes the event filter (e.g. "only notes with tag X");
`inputSchema` shapes the action's arguments; `provision` tells the hub how to
wire it. Both arrays are optional; a module with no cross-module surface
declares neither.

## Why this shape

- **Author-controlled.** The package author declares everything in one
  file in their published artifact. No central registry, no PR against
  Parachute repos, no naming approval.
- **Caller-agnostic to the CLI.** First-party and third-party modules
  go through the same `module.json` path. The first-party
  `SERVICE_SPECS` table is a transitional shortcut.
- **Hub doesn't inspect names.** A `services.json` entry written from
  any `module.json` renders identically to first-party entries. The
  hub already treats any conformant entry as first-class — see
  [`module-protocol.md`](./module-protocol.md).
- **Scope namespace = module name.** No central registry of scope
  names. A `my-service` module owns `my-service:*`. Names are unique
  across the ecosystem because `services.json` keys are unique.
- **Composable with auto-wiring.** The `dependencies` block is what
  makes `parachute install <module>` able to mint a token (today: a
  shared secret; Phase B2: a JWT) and inject it into both ends —
  callee gets the validator material, caller gets the credential —
  without the user manually copying anything.

## How the CLI consumes it (target)

`parachute install <package>` will run:

1. `bun add -g <package>` — standard npm install. No naming constraint.
2. Read `<package>/.parachute/module.json` from the installed artifact.
3. Validate against the module-manifest schema. Reject malformed
   modules early.
4. Write a `services.json` entry using the declared `name`, `port`,
   `paths`, `health`, `displayName`, `tagline`.
5. Register `startCmd` so `parachute start <name>` knows what to spawn.
6. For each `dependencies` entry, run `auto-wire` (mints credential,
   writes both ends, idempotent) — same machinery the vault↔scribe
   pair already uses. See
   [`service-to-service-auth.md`](./service-to-service-auth.md).

The first-party `SERVICE_SPECS` record stays as a fallback for
packages that pre-date the convention, then retires.

## Rules

- **`name` is the unique identifier.** Reuse of `name` across packages
  is a conflict — `services.json` keys must be unique. CLI fails the
  install if `name` collides with an existing entry.
- **`name` is the scope namespace.** A module declaring
  `defines: ["foo:read"]` must have `name: "foo"`. Otherwise a third
  party could squat scopes the user already trusts for a different
  module.
- **Port outside the reserved range when you can.** The Parachute
  range `1939–1949` is for first-party modules. Third-parties pick
  outside; the CLI warns but does not block.
- **`startCmd` must be argv, not a shell string.** Avoids
  shell-injection weirdness when users have spaces in package paths.
- **`init.command[0]` must be a bin from the installed package.** The
  CLI rejects manifests at install time when `init.command[0]` isn't
  declared as a bin in the package's `package.json`. This keeps `init`
  from invoking arbitrary `$PATH` binaries — see [Install-time
  behaviors](#install-time-behaviors) above.
- **`module.json` is shipped in the npm artifact.** Not in
  `.gitignore`, not generated at install time. The CLI reads it
  post-install from the installed package directory.
- **Don't mutate the caller's `module.json` at install time.** If the
  CLI needs install-time state (assigned port, generated secret), it
  goes in `~/.parachute/<name>/.env` (see
  [`cli-as-port-authority.md`](./cli-as-port-authority.md)), not in
  the package's source.

## What this isn't

- **A package-naming convention.** First-party packages happen to use
  `parachute-*` (see [`naming/bins.md`](../naming/bins.md)) but the
  ecosystem doesn't require it. `module.json` is what makes a package
  a Parachute module.
- **A registry.** There is no central index of installed third-party
  modules. Discovery is per-machine via `~/.parachute/services.json`,
  exactly like first-party modules.
- **A trust mechanism.** `module.json` makes a package
  *Parachute-compatible*; it doesn't make it trusted. Users still
  decide what to install. The hub-as-OAuth-issuer architecture is
  what gates capability grants; see
  [`hub-as-issuer.md`](./hub-as-issuer.md).

## Where this applies

- **Today:** first-party modules (vault, notes, scribe, agent) are
  hardcoded in `parachute-hub/src/service-spec.ts`. The shape lives in
  `PORT_RESERVATIONS` + `SERVICE_SPECS` and is functionally a
  pre-`module.json` ancestor.
- **Tomorrow (target):** every module — first-party and third-party —
  ships its own `module.json`. The CLI reads it; the hardcoded
  `SERVICE_SPECS` table goes away or shrinks to a transitional
  fallback.
- **Reference for authors:** the design doc at
  [`parachute.computer/design/2026-04-20-module-architecture.md`](https://github.com/ParachuteComputer/parachute.computer/blob/main/design/2026-04-20-module-architecture.md)
  is the live shape until this pattern doc and the CLI implementation
  catch up.

## Versioning

The schema is **backwards-compatible**. Every field added to date —
including the 2026-04-30 `hasAuth` / `init` / `urlForEntry` extension
and the 2026-05-02 `managementUrl` addition — is optional with a
sensible "absent" default. Existing manifests stay valid; existing
parsers ignore fields they don't understand. When (if) the shape
evolves breakingly, we'll add a `manifestVersion: 1` discriminator.
Defer until a v2 shape is real.

## Migration

The 2026-04-30 schema extension exists to retire hub's transitional
`FIRST_PARTY_FALLBACKS.extras` block (see
`parachute-hub/src/service-spec.ts`). Sequence:

1. **This PR (parachute-patterns)** — define the three fields. Done.
2. **parachute-hub parser update** — extend `module-manifest.ts`'s
   validator to read the new fields, route them through
   `composeServiceSpec` so the spec produced from a real `module.json`
   carries the same `hasAuth` / `init` / `urlForEntry` semantics the
   fallback's `extras` block does. Add the `init.command[0]` bin-name
   check at install time (resolved via the installed package's
   `package.json` `bin`).
3. **vault / scribe / notes** — emit the new fields in their shipped
   `.parachute/module.json`. One PR per module.
4. **parachute-hub fallback retirement** — delete each module's
   `FALLBACK:` entry once the corresponding upstream `module.json`
   carries the equivalent declarations.

Until step 2 ships, the new fields validate only against this doc, not
against running code. Authors writing third-party modules can include
them today; the hub will start honoring them once the parser update
lands.

## Open questions

- **Schema location.** Do we publish a JSON Schema for `module.json`
  (e.g. `https://parachute.computer/schemas/module.json/v1`)?
  Defer until the validator is being written — premature otherwise.
- **Consumer registry.** `urlForEntry.perConsumer` keys against the
  hub's curated consumer list. Today that list is implicit (defined by
  the union of `module.json` references). Surface it as
  `/.parachute/consumers` once a third consumer arrives; until then the
  list of "well-known" consumers is short enough to keep in code.
- **Capabilities.** The richer `manifest` shape in the design doc has
  `capabilities`, `iconUrl`, `endpoints` etc. Today most of those
  duplicate what `/.parachute/info` already exposes at runtime.
  `module.json` is install-time; runtime metadata stays at
  `/.parachute/info` (see [`module-protocol.md`](./module-protocol.md)).
  The boundary is "what the CLI needs to install and route" lives in
  `module.json`; "what the hub fetches every render" stays at
  `/.parachute/info`.
