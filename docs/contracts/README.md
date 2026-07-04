# Hub-enforced contracts

Contract docs the hub enforces. These moved here verbatim from `parachute-patterns/patterns/` (2026-07-04, patterns-archive decision: the patterns repo archives; each live-cited contract doc moves to the repo that enforces it). Other repos cite some of these cross-repo — surface, vault, and scribe all reference the module protocol / manifest / OAuth docs below — so treat renames or removals here as ecosystem-facing changes.

| Contract | Governs |
|---|---|
| [`module-protocol.md`](./module-protocol.md) | The module lifecycle protocol: info / config / services.json registration / well-known discovery — what a Parachute module must implement to be supervisable. |
| [`module-json-extensibility.md`](./module-json-extensibility.md) | The `.parachute/module.json` manifest shape and its extensibility rules (unknown-field passthrough, capability fields, no `kind` branching). |
| [`module-ui-declaration.md`](./module-ui-declaration.md) | How modules declare UI URLs in `module.json` and how the hub renders discovery tiles (URL resolution by form: absolute / origin-absolute / mount-relative). |
| [`services-json-row-conventions.md`](./services-json-row-conventions.md) | The `~/.parachute/services.json` row shape: `manifestName` keying, required vs pass-through fields, who owns the write side. |
| [`hub-as-issuer.md`](./hub-as-issuer.md) | The single-OAuth-issuer rule: the hub origin is the ecosystem's one issuer; modules advertise it and validate its tokens. |
| [`oauth-scopes.md`](./oauth-scopes.md) | Scope-string grammar and the scope registry: whitespace-separated `service:verb`-shaped scopes on every Parachute token. |
| [`oauth-dcr-approval.md`](./oauth-dcr-approval.md) | The Dynamic Client Registration approval lifecycle: every DCR client is pending until an operator approves it. |
| [`hub-module-boundary.md`](./hub-module-boundary.md) | The ownership charter: hub = substrate (identity, issuance, transport, supervision), modules = domain; the seam is module surfaces driving hub identity APIs. |
| [`design-system.md`](./design-system.md) | The Parachute design system: brand mark, palette, type stack, verb + state vocabulary for every Parachute surface. |

Note: the docs are verbatim copies (plus a provenance header). Relative links between the nine contracts resolve. Relative links to patterns that did **not** move (e.g. `./canonical-ports.md`, `./governance.md`, `./trust-gradient-isolation.md`) are **dead in this repo** — they were written for the patterns repo's layout. Find those files in the read-only archive: <https://github.com/ParachuteComputer/parachute-patterns/tree/main/patterns>. (Kept verbatim on purpose: editorial fixes to a moved contract are their own PRs, not part of the move.)
