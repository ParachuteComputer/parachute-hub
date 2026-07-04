> Moved from parachute-patterns/patterns/hub-as-issuer.md (2026-07-04) — see the patterns-archive decision. This repo enforces this contract.

# Hub as OAuth issuer

## Convention

The Parachute ecosystem has **one OAuth issuer**: the hub origin. Every
auth-capable module advertises the hub as `issuer` and accepts tokens
that pin trust to the hub URL — not to the module's internal address.

In Phase 0+1 (today), vault is the only module that runs OAuth
endpoints. It still serves `/oauth/authorize`, `/oauth/token`,
`/oauth/register`, and the discovery documents — but its `issuer`
metadata is the hub origin whenever the client reached vault through
the hub. The user-visible authority is always the hub; vault is the
implementation behind it.

## The two views

The same vault process serves two legitimate issuer views concurrently:

| Client reached vault via… | `issuer` it sees |
|---|---|
| The hub origin (`PARACHUTE_HUB_ORIGIN`, e.g. `https://you.tail-net.ts.net`) | The hub origin |
| Direct loopback (`http://127.0.0.1:1940/vault/<name>`) | The vault-local URL |

This is RFC 8414 compliant on both sides — the issuer always matches
the origin the client is actually talking to. Discovery, token `iss`
claims, and the service catalog returned with the token all stem from
one resolver, so they can never disagree.

Canonical implementation:
[`parachute-vault/src/oauth.ts`](https://github.com/ParachuteComputer/parachute-vault/blob/main/src/oauth.ts)
(`resolveOAuthCoordinates`, `resolvePublicOrigin`). The hub origin is
derived once by the CLI in
[`parachute-hub/src/hub-origin.ts`](https://github.com/ParachuteComputer/parachute-hub/blob/main/src/hub-origin.ts)
(`deriveHubOrigin`) and passed through to vault as `PARACHUTE_HUB_ORIGIN`
on `expose up` / `start` (see
[`parachute-hub/src/commands/expose.ts`](https://github.com/ParachuteComputer/parachute-hub/blob/main/src/commands/expose.ts)).

## Why

- **The front door owns identity.** Conflating "data service" with
  "identity provider" couples them in ways that make extraction painful
  later. Putting the issuer at the hub means vault, scribe, channel,
  and every future module can stay narrowly scoped.
- **One issuer for the user.** A user grants consent to "Parachute" at
  one URL, not separately to vault, scribe, and channel. Tokens carry
  scopes ([`oauth-scopes.md`](./oauth-scopes.md)) for every service in
  the ecosystem, signed by the same issuer.
- **Same shape local and remote.** A loopback dev install and a
  tailnet-exposed install run the same code; only the hub origin
  changes. Discovery, token `iss`, and refresh flows all follow.
- **Clean extraction path.** Today vault's OAuth implementation powers
  the issuer behind the scenes. When the hub grows its own IdP (Phase
  B2 below), the user-visible URL doesn't change — clients keep using
  the same `issuer`, and the implementation moves underneath them.

## Status

**Phase 0+1 (live, 2026-04-23):** vault implements all OAuth endpoints
and discovery. When `PARACHUTE_HUB_ORIGIN` is set and the request
arrives via that origin, vault advertises the hub as `issuer` and emits
the hub URL in the `iss` claim of issued tokens. When unset (or when
the request arrives via direct loopback), vault advertises itself as
issuer at `http://127.0.0.1:1940/vault/<name>`. Same vault, two
origin-consistent views.

**Phase B2 (target, post-launch):** the hub becomes the IdP itself.
Hub serves `/.well-known/oauth-authorization-server` and `/oauth/*`
directly; vault becomes a pure resource server that validates
hub-issued JWTs via JWKS. A small shared scope-guard library lives in
[`parachute-patterns`](./oauth-scopes.md)'s upstream code home (TBD)
so every module enforces the same scope semantics. Tracked in
[`parachute-hub#58`](https://github.com/ParachuteComputer/parachute-hub/issues/58)
and
[`parachute-vault#169`](https://github.com/ParachuteComputer/parachute-vault/issues/169).

The user-facing URL — and therefore the token's `iss` claim — does not
change between Phase 1 and Phase B2. Only the implementation does.

## Rules

- **`issuer` matches the origin.** Whatever URL the client reached you
  on, that origin is the issuer they see. Don't return a hard-coded
  issuer from config; resolve it per request.
- **Hub origin comes from `PARACHUTE_HUB_ORIGIN` (env).** Set by the
  CLI on hub-fronted processes; absent on standalone runs. Don't
  re-derive it inside services — read the env var.
- **Tokens pin trust to the issuer URL.** Downstream services
  validating a token compare `iss` against the hub origin they were
  configured with. Never trust a token whose `iss` doesn't match the
  expected issuer.
- **Standalone fallback is intentional.** A vault running without a
  hub advertises itself as issuer. Don't break this — it's how
  developers without a tailnet still get a coherent OAuth surface.
- **`authorization_servers` in protected-resource metadata points at
  the issuer.** RFC 9728: the AS metadata locator is whatever the
  client should trust as the issuer. Today vault hosts the AS metadata
  document on its own origin even when the issuer is the hub — the
  document still reports `issuer = hub`. See
  [`well-known-discovery-rfc.md`](./well-known-discovery-rfc.md) (when
  it lands) for the path-component subtleties.

## Where this applies

- **`parachute-vault`** — implements the issuer surface; honours
  `PARACHUTE_HUB_ORIGIN`. Reference `resolveOAuthCoordinates` in
  `src/oauth.ts`.
- **`parachute-hub`** — derives the canonical
  hub origin once, passes it through to every service it spawns. See
  `src/hub-origin.ts` + `src/commands/expose.ts`.
- **`parachute-scribe`** — scopes declared, OAuth enforcement waiting
  on Phase B2 (hub-issued JWTs validated via JWKS). No issuer surface
  of its own.
- **`parachute-notes` / future frontends** — perform OAuth against the
  issuer URL (hub origin); never against a vault-local URL.

## Open questions

- **Multi-vault and scope narrowing.** A single hub fronts N vaults
  today, each at `/vault/<name>`. The issuer is still the hub origin
  for all of them; per-vault narrowing is a scope concern, not an
  issuer concern. See `oauth-scopes.md` "Future: deeper per-resource
  narrowing".
- **Token format at the Phase B2 cutover — resolved.** Tokens were
  opaque `pvt_*` strings looked up by hash on the issuing vault; the
  cutover to hub-signed JWTs completed, and the `pvt_*` issuance path
  then retired entirely (vault#412 — see
  [`token-auth.md`](./token-auth.md)'s supersession banner). No bridge
  period remains: hub-minted JWTs are the only issuance.
- **Refresh and step-up flows across modules.** A token granted
  `vault:read` requesting `scribe:transcribe` later is conceptually one
  hub re-prompt, but the dance touches every module. Designed in
  [`design/2026-04-20-hub-as-portal-oauth-and-service-catalog.md`](https://github.com/ParachuteComputer/parachute.computer/blob/main/design/2026-04-20-hub-as-portal-oauth-and-service-catalog.md);
  not yet implemented.

## What's out of scope here

- **Scope format and inheritance** — see [`oauth-scopes.md`](./oauth-scopes.md).
- **DCR client approval lifecycle** (`pending` → `approved`, the four
  operator paths) — see [`oauth-dcr-approval.md`](./oauth-dcr-approval.md).
- **Well-known metadata path math (RFC 8414 + RFC 9728)** — see
  [`well-known-discovery-rfc.md`](./well-known-discovery-rfc.md) when
  it lands.
- **Service-to-service auth** (e.g. vault → scribe webhook) — see
  [`service-to-service-auth.md`](./service-to-service-auth.md) when it
  lands. That's a separate trust axis from user OAuth.
