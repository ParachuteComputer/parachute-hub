# @openparachute/scope-guard

Hub-issued JWT validation for Parachute resource servers (vault, scribe, paraclaw, third-party modules).

The Parachute hub mints OAuth access tokens as RS256 JWTs and publishes its public keys at `/.well-known/jwks.json`. This library is the consumer-side mirror: every resource server uses the same verifier so the trust kernel doesn't drift between modules.

## What's in the box

- **`createScopeGuard({ hubOrigin, jwks?, jwksGetter? })`** — factory bound to a hub origin. Holds the JWKS getter so the cache lives across requests. `hubOrigin` may be a string or a resolver function (for layered env-var precedence).
- **`guard.validateHubJwt(token, { expectedAudience? })`** — JWKS-backed verify. Pins `iss` to the configured hub origin, strict-checks `aud` (RFC 7519 string-or-array) when supplied. Throws `HubJwtError` (with a `code`) on failure.
- **`parseScopes(raw)` / `extractBearer(authHeader)` / `looksLikeJwt(token)`** — string helpers every consumer reaches for.
- **`hasScope(granted, required)`** — generic `<resource>:<verb>` and `<resource>:<name>:<verb>` matcher with `admin ⊇ write ⊇ read` inheritance. The lib is the engine, not the dictionary; per-service vocabularies and cross-resource catch-alls stay in each service.
- **`HubJwtError.code`** — single error class with a coarse code: `signature | issuer | expired | kid | jwks | audience | shape`. Branch on `code` rather than catching subclasses.

## Quick start

```ts
import { createScopeGuard, extractBearer, hasScope } from "@openparachute/scope-guard";

const guard = createScopeGuard({
  hubOrigin: () => process.env.PARACHUTE_HUB_ORIGIN ?? "http://127.0.0.1:1939",
});

async function enforceAuth(req: Request, vaultName: string) {
  const token = extractBearer(req.headers.get("authorization"));
  if (!token) return new Response("missing bearer token", { status: 401 });

  try {
    const claims = await guard.validateHubJwt(token, {
      expectedAudience: `vault.${vaultName}`,
    });
    if (!hasScope(claims.scopes, `vault:${vaultName}:read`)) {
      return new Response("insufficient scope", { status: 403 });
    }
    return { ok: true as const, claims };
  } catch (err) {
    return new Response(`invalid token (${(err as { code?: string }).code ?? "unknown"})`, {
      status: 401,
    });
  }
}
```

## Design

See [`parachute-hub/docs/design/2026-04-29-scope-guard-library.md`](https://github.com/ParachuteComputer/parachute-hub/blob/main/docs/design/2026-04-29-scope-guard-library.md) for full rationale, alternatives considered, and the migration sequence (vault → scribe → paraclaw).

The lib lives as a sub-package of `parachute-hub` because the hub owns the JWT-issuance side and the scope vocabulary. It's published independently to npm as `@openparachute/scope-guard`.

## Versioning

Pre-1.0 (`0.x.y`) — this is a young library:

- **Patches (`0.1.0` → `0.1.1`)** are additive and behavior-preserving. Adopters can take patch bumps without review.
- **Minors (`0.1.x` → `0.2.0`)** may break adopters. Read the CHANGELOG before bumping.
- **`-rc.N` prereleases** match the broader Parachute ecosystem's pre-1.0 governance — landed on the `rc` dist-tag on every code-touching PR; promotion to `@latest` is a deliberate `npm dist-tag` step.

The library's RC cadence is **independent of `@openparachute/hub`'s** — they're shipped from the same repo but aren't coupled in version. A hub release doesn't imply a scope-guard release and vice versa.

Post-1.0 the library will follow standard semver — minors backward-compatible, majors with a migration note.

## License

AGPL-3.0
