> Moved from parachute-patterns/patterns/module-protocol.md (2026-07-04) — see the patterns-archive decision. This repo enforces this contract.

# Module protocol

> **Note (2026-05-23):** The `kind` field has been removed from the canonical
> manifest shape ([hub#327](https://github.com/ParachuteComputer/parachute-hub/pull/327)
> made it optional; [hub#330](https://github.com/ParachuteComputer/parachute-hub/issues/330)
> completes the retirement). Hub doesn't branch on kind anymore; capabilities
> are explicit (`paths`, `health`, `managementUrl`, `uiUrl`). See
> [`module-surfaces.md`](./module-surfaces.md) for the canonical framing.

## Convention

Every Parachute module plugs into the ecosystem by implementing the same
small set of contracts. The hub (and any other consumer) can discover,
identify, configure, and route to any module — first-party or third-party —
without hub-side code changes. "Module" is the primary noun; the hub is a
module that happens to also orchestrate.

The protocol has three layers:

### 1. Storage — `~/.parachute/services.json`

The installed-module registry. One entry per module, written at install
time by `parachute install`. Canonical source of truth for which modules
exist on this machine and how to reach them.

```json
{
  "name": "parachute-vault",
  "port": 1940,
  "paths": ["/vault/default"],
  "health": "/vault/default/health",
  "version": "0.3.0",
  "displayName": "Vault",
  "tagline": "Agent-native knowledge graph …"
}
```

Canonical shape: [`parachute-hub/src/services-manifest.ts`](https://github.com/ParachuteComputer/parachute-hub/blob/main/src/services-manifest.ts).

### 2. Runtime — `/.parachute/*` endpoints

Every module serves these under its own mount path. No auth for `info` /
`icon.svg` / `config/schema`; reads/writes to `config` are scope-gated once
Phase 2+ lands.

| Path | Purpose | Auth |
| --- | --- | --- |
| `GET /.parachute/info` | identity + version + capabilities | none (CORS `*`) |
| `GET /.parachute/icon.svg` | small inline SVG, `image/svg+xml` + `nosniff` | none |
| `GET /.parachute/config/schema` | JSON Schema for configuration | none |
| `GET /.parachute/config` | current config values | `<module>:admin` (Phase 2) |
| `PUT /.parachute/config` | write config, validated against schema | `<module>:admin` (Phase 3) |

Reference implementation dispatches these in
[`parachute-vault/src/routing.ts`](https://github.com/ParachuteComputer/parachute-vault/blob/main/src/routing.ts)
(`/.parachute/info`, `/.parachute/icon.svg`, `/.parachute/config/schema`,
`/.parachute/config`).

**Module-owned config UI + connections (added 2026-06-09).** Under the
[modular-UI architecture](../design/2026-06-09-modular-ui-architecture.md),
a module's config UI is the module's own surface — it serves it and declares
`configUiUrl` in `module.json`; the hub frames / links it from a uniform
config shell rather than hard-coding a per-module view. The same shift adds
`events` (what a module emits) and `actions` (what it accepts) to `module.json`,
which feed the hub's general **Connections** surface (when [event] → do
[action]). The runtime `/.parachute/config` + `/.parachute/config/schema`
endpoints remain the live-config seam; `configSchema` in `module.json`
promotes the schema to install-time. Full field catalog:
[`module-json-extensibility.md` — Modular-UI fields](./module-json-extensibility.md#modular-ui-fields).

### 3. Discovery — `/.well-known/parachute.json`

The hub aggregates every installed service's storage entry into a single
document at `/.well-known/parachute.json` on the ecosystem origin. Clients
(the hub page, third-party integrations, future agents) fetch this once and
iterate, then fan out to each service's `/.parachute/info` for live
metadata.

Shape (see
[`parachute-hub/src/well-known.ts`](https://github.com/ParachuteComputer/parachute-hub/blob/main/src/well-known.ts)):

```json
{
  "vaults":   [{ "name": "default", "url": "…", "version": "…" }],
  "services": [{ "name": "…", "url": "…", "path": "…", "version": "…", "infoUrl": "…/.parachute/info" }],
  "<shortName>": { "url": "…", "version": "…" }   // back-compat, one per service
}
```

Served by
[`parachute-hub/src/hub-server.ts`](https://github.com/ParachuteComputer/parachute-hub/blob/main/src/hub-server.ts);
the hub page fetch lives in
[`parachute-hub/src/hub.ts`](https://github.com/ParachuteComputer/parachute-hub/blob/main/src/hub.ts).

## Why

- **Open by construction.** The protocol is the standard, not the package
  names. A module called `my-cool-thing` that ships the four required
  contracts is a first-class Parachute module — no `@openparachute/` scope
  or `parachute-*` prefix required. See
  [`module-json-extensibility.md`](./module-json-extensibility.md) when
  that pattern lands.
- **Hub stays thin.** `services.json` + `/.well-known/parachute.json` +
  `/.parachute/info` on each module is everything the hub needs. No
  per-module special-casing in hub code.
- **Same shape local and remote.** A loopback vault on port 1940 and a
  cloud-hosted vault at `vault.example.com` speak the same protocol. Cloud
  is a hosting option, not a separate product.
- **Additive evolution.** New keys in the well-known doc and new
  `/.parachute/*` endpoints are optional. Old clients keep working; the
  `services[]` array was added alongside the original flat-shortName keys
  for exactly this reason.

## Rules

- **Mount at `/.parachute/*` literally.** Not `/api/parachute/*`, not
  `/v1/.parachute/*`. Keeps cross-module URL construction uniform.
- **`info` + `icon.svg` are unauthenticated and CORS-open.** The hub page
  loads them from the browser with `credentials: 'omit'`.
- **Every service gets one `services.json` entry.** Multi-tenant modules
  (e.g. multiple vaults) write one entry per instance with distinct `name`
  + `paths`.
- **Pick a port in the reserved range when you can.** See
  [`canonical-ports.md`](./canonical-ports.md). Third parties should stay
  out of 1939–1949.

## What's out of scope here

- OAuth issuer location and scope format — see
  [`hub-as-issuer.md`](./hub-as-issuer.md) and
  [`oauth-scopes.md`](./oauth-scopes.md).
- Third-party module manifest (`.parachute/module.json`) shape — see
  [`module-json-extensibility.md`](./module-json-extensibility.md), including
  the 2026-06-09 modular-UI fields (`configUiUrl`, `focus`, `events`,
  `actions`).
- Self-registration-driven discovery (no whitelist) + the `focus` tier — see
  [`module-discovery.md`](./module-discovery.md).
- Where a module's user / admin / config UI is declared (`uiUrl` /
  `managementUrl` / `configUiUrl`) — see
  [`module-ui-declaration.md`](./module-ui-declaration.md).
- Well-known metadata for OAuth (RFC 8414 / RFC 9728) — see
  [`well-known-discovery-rfc.md`](./well-known-discovery-rfc.md).

## Status

Live. Phase 0 (launch, 2026-04-23) ships `services.json`,
`/.parachute/info`, `/.parachute/icon.svg`, `/.well-known/parachute.json`
across vault + notes + scribe + channel + hub. Phase 2 adds
`/.parachute/config/schema` + `GET /.parachute/config`; Phase 3 adds
`PUT /.parachute/config` and the auto-wiring story. Track the full phasing
in
[`parachute.computer/design/2026-04-20-module-architecture.md`](https://github.com/ParachuteComputer/parachute.computer/blob/main/design/2026-04-20-module-architecture.md).
