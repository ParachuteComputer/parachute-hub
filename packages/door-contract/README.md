# @openparachute/door-contract

The Parachute **door contract** — the OAuth-issuer + `/account/*` wire types,
constants, and conformance vectors that **both doors** implement:

- the **self-host hub** (`@openparachute/hub`, Bun) and
- the **hosted cloud** (`@openparachute/cloud`, Cloudflare Workers).

Cloud's job is to "reproduce the hub's issuer contract exactly." Today that
contract is duplicated: the token TTL/grace constants, the discovery-doc shape,
the token claim set, the account scope grammar, and the `/account/*` route table
each exist twice, kept in sync only by prose comments and two separate test
suites. This package is where "exactly" is written down **once**.

Sibling to [`@openparachute/scope-guard`](../scope-guard), which owns the
resource-server side (JWT validation + the vault scope matcher). `door-contract`
owns the **door/issuer** side.

## What's in here

| Module | Contract |
|---|---|
| `tokens.ts` | `ACCESS_TOKEN_TTL_SECONDS`, `REFRESH_TOKEN_TTL_MS`, `REFRESH_GRACE_MS`, `TOKEN_TYPE`, `SIGNING_ALG` + `AccessTokenClaims` / `TokenResponse` |
| `scopes.ts` | the `account:<id>:<verb>` grammar (`admin ⊇ read`) + `hasAccountScope` |
| `discovery.ts` | RFC 8414 / 9728 metadata vectors: `expected*Metadata(issuer, …)` |
| `account-contract.ts` | the `/account/*` route table (`ACCOUNT_ROUTES`) + request/response types |
| `conformance.ts` | the shared corpus + `check*` helpers a door's suite drives against its live handlers |

## Usage — a door's conformance suite

```ts
import { checkAuthorizationServerMetadata } from "@openparachute/door-contract";

const res = await app.fetch(new Request(`${ISSUER}/.well-known/oauth-authorization-server`));
const md = await res.json();
expect(checkAuthorizationServerMetadata(md, ISSUER, ADVERTISED_SCOPES)).toEqual([]);
```

## Design

- **Pure.** No runtime dependencies — no `jose`, no D1/SQLite. Data, types, and
  pure functions only. Each door keeps its own (forked) runtime; only the
  *contract* is shared.
- **Drift-detected.** Each door ships a parity test asserting its live runtime
  values equal the canon here. A real contract change happens here, and the
  parity tests then force each door to follow — the mechanism that keeps the two
  issuers from silently diverging.
- **`.js` relative imports.** Resolved to `.ts` by bun + bundler consumers;
  keeps a future NodeNext/npm build a mechanical flip (the scope-guard #225
  lesson).

## License

AGPL-3.0.
