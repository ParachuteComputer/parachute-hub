> Moved from parachute-patterns/patterns/services-json-row-conventions.md (2026-07-04) — see the patterns-archive decision. This repo enforces this contract.

# services.json row conventions

> Each module's row in `~/.parachute/services.json` is keyed by
> `manifestName` (e.g. `"parachute-vault"`) — NOT the short name
> (`"vault"`). Self-register writes and hub install writes must agree on
> the key, or you get duplicate rows fighting over the same port.

## The convention (TL;DR)

When a module self-registers via the canonical pattern (see
[`module-self-registration.md`](./module-self-registration.md)), the
`ServiceEntry` written to `~/.parachute/services.json` MUST use the
module's `manifestName` as the row's `name`:

```ts
const entry: ServiceEntry = {
  name: manifest.manifestName,  // "parachute-<short>", NOT "<short>"
  port: ...,
  paths: ...,
  // ... etc
};
```

Hub looks up rows by `manifestName`. Hub's install path writes new rows
keyed on `manifestName`. If self-register writes the short name and
install writes the manifestName, hub sees two rows — and the next
services.json read fails with `duplicate port <N> — claimed by both
"<short>" and "parachute-<short>"`.

## Why — the constraint that produced it

Hub's install path
([`parachute-hub/src/api-modules-ops.ts`](https://github.com/ParachuteComputer/parachute-hub/blob/main/src/api-modules-ops.ts))
uses `findService(spec.manifestName)` to detect existing rows and
writes new rows with `name: spec.manifestName`. Examples from that
file:

```ts
const existing = findService(spec.manifestName, deps.manifestPath);
// ...
const entry = { manifestName: spec.manifestName, /* ... */ };
```

The CLI surface (`parachute install <short>`) accepts the short name
from operators, but internally resolves to `manifestName` for every
services.json operation. The split is intentional — short is
human-friendly, `manifestName` is the canonical key.

If a module's self-register writes a row with the short name and the
install path later writes the same module's row keyed on
`manifestName`, you end up with two rows pointing at the same daemon
on the same port. services.json readers that enforce port-uniqueness
(hub's port-collision check, the admin SPA catalog) reject the file
with a duplicate-port error. The daemon won't start until the
duplicate row is removed by hand.

## Examples (canonical implementations)

- vault: [`parachute-vault/src/self-register.ts`](https://github.com/ParachuteComputer/parachute-vault/blob/main/src/self-register.ts) — `name: manifest.manifestName`
- scribe: [`parachute-scribe/src/self-register.ts`](https://github.com/ParachuteComputer/parachute-scribe/blob/main/src/self-register.ts) — `name: module.manifestName`
- app: [`parachute-surface/packages/app-host/src/self-register.ts`](https://github.com/ParachuteComputer/parachute-surface/blob/main/packages/app-host/src/self-register.ts) — `name: ROW_NAME` (pre-resolved from `module.json`'s `manifestName` at module scope)
- runner: [`parachute-runner/src/self-register.ts`](https://github.com/ParachuteComputer/parachute-runner/blob/main/src/self-register.ts) — same pattern as app

The `ROW_NAME` const variant (app + runner) is slightly safer than the
inline `manifest.manifestName` variant (vault + scribe): the row name
is resolved once at module load, used for both `readServiceEntry` and
the entry write, so the read and write keys are guaranteed identical.
Both shapes are correct — the load-bearing rule is that the key
matches `manifestName`.

## The CLI surface uses the short name; everything else uses manifestName

| Surface | Identifier shape | Example |
| --- | --- | --- |
| Operator CLI (`parachute install`, `parachute restart`) | short | `parachute install app` |
| services.json row `name` field | manifestName | `"parachute-surface"` |
| Hub `findService` lookups | manifestName | `findService("parachute-surface")` |
| Module-discovery URL paths | short or per-paths from `module.json` | `/surface/...` |
| npm package name | scoped manifestName | `@openparachute/surface` |

The CLI translates short → `manifestName` at the boundary; downstream
code never sees the short name. The two namespaces share a stem
(`<short>` ⇄ `parachute-<short>`) but they're separate identifier
spaces — don't conflate.

## Future-proofing — checklist for a new module

When writing a new module's self-register:

1. Set `manifestName` in `.parachute/module.json` to the npm package
   slug (e.g. `@openparachute/<name>` → `manifestName:
   "parachute-<name>"`).
2. In self-register, set `name: manifest.manifestName` — or hoist to a
   `ROW_NAME` const at module scope (app/runner style) and reference
   that same const in every services.json read/write call.
3. Run [`scripts/audit-canonical-refs.sh`](../scripts/audit-canonical-refs.sh)
   from the workspace root; the
   `self-register row name` block will flag any literal short-name
   write.

## History

- **2026-05-22**: Aaron hit a `duplicate port 1946 — claimed by both
  "parachute-surface" and "app"` error walking a fresh install. Root cause:
  parachute-surface's self-register wrote `name: "app"` while hub's install
  path had earlier stamped `name: "parachute-surface"`. Same shape latent
  in parachute-runner (`name: "runner"`). Fixed inline in
  [parachute-surface#13](https://github.com/ParachuteComputer/parachute-surface/pull/13)
  and
  [parachute-runner#4](https://github.com/ParachuteComputer/parachute-runner/pull/4).
  Pattern doc landed same day to prevent recurrence; audit script
  extended to catch the bug shape going forward.

## Related patterns

- [`module-self-registration.md`](./module-self-registration.md) — the
  broader self-register pattern this convention lives within. Row
  identity is the single load-bearing field self-register has to get
  right.
- [`canonical-ports.md`](./canonical-ports.md) — the port-uniqueness
  invariant that duplicate-rows-with-same-port violate.
- [`module-json-extensibility.md`](./module-json-extensibility.md) —
  where `manifestName` lives and what shape it takes.
