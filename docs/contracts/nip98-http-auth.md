# NIP-98 HTTP authentication (the `/mcp` door)

The wire contract for authenticating to the hub with a **signed nostr event
per request** instead of an OAuth bearer — the key-holder path, for an agent
that has a secp256k1 secret key and no browser, no client registration, and no
token to store.

Enforced by [`src/nostr-http-auth.ts`](../../src/nostr-http-auth.ts) and
[`src/nostr-event.ts`](../../src/nostr-event.ts); every claim below cites the
line that implements it. Reference client: **`@openparachute/mcp`**
(`parachute-surface/packages/parachute-mcp/src/nip98.ts` +
`signing-fetch.ts`), verified to interoperate — read it before writing your own.

## 1. Where it is accepted

Routing is by header shape alone: `isNostrAuthorization` matches `/^Nostr\s+/i`
(`nostr-http-auth.ts:396`). Once the header starts with `Nostr` there is no
negotiation and no bearer fallback.

| Endpoint | Methods | Handler | Notes |
| --- | --- | --- | --- |
| `/mcp`, `/mcp/*` | POST, DELETE; `OPTIONS` **only if the preflight itself carries the header** (§1.1) | `hub-server.ts:4285` → `handleAccountMcp` | **Canonical door.** Dispatched before the per-vault proxy and every services.json mount, so no module can claim it. |
| `/account/mcp` | POST, DELETE, OPTIONS | `account-mcp-http.ts:403` | Same handler, legacy path, reached directly — so unauthenticated browser preflight *does* work here. New clients should otherwise use `/mcp`. |
| every `requireScope`-gated admin route | per route | `admin-auth.ts:110` | `/api/users/*`, `/api/hub/*`, `/vaults`, `/admin/grants`, … — the host-admin REST surface accepts `Nostr` wherever it accepts a host-admin bearer. |

At `/mcp` the branch is `isNostrAuthorization(req) || peekBearerAudience(req)
=== "account"` (`hub-server.ts:4293`); anything else — a vault-audience bearer,
an API key — proxies to the vault daemon, which does **not** speak NIP-98 and
answers `401 API key required`. Cookie sessions never open this door. Note that
`forceChangePasswordGate` runs first (`hub-server.ts:4290`), before the NIP-98
branch; it is a no-op for a cookie-less client.

### 1.1 OPTIONS at `/mcp` is not an unauthenticated preflight

The `/mcp` dispatch selects the account door **by the `Authorization` header**,
and a CORS preflight by definition carries none. So an unauthenticated
`OPTIONS /mcp` does not reach `handleAccountMcp` at all: `accountMcp` is false
and the request falls through to `proxyToVaultDaemon` (`hub-server.ts:4306`),
or to `vaultModuleNotRunning()` (`:4308`) if no vault module is registered.
(That second branch is narrower than "the daemon is down": `proxyToVaultDaemon`
returns `undefined` only when services.json carries no `vault` row
(`hub-server.ts:1075`). A loopback-exposure mismatch returns a plain 404
(`:1076`–`:1078`), and a registered-but-crashed daemon still goes through
`proxyRequest`.) `isCorsAllowedRoute` (`cors.ts:214`) covers only `/oauth/`, so
nothing widens this.

- **Practical consequence:** the vault daemon's preflight answers
  `Access-Control-Allow-Headers: Content-Type, Authorization, X-API-Key,
  Mcp-Session-Id` (`parachute-vault/src/server.ts:620`, as of parachute-vault
  `next`, 2026-09-01) — no `Mcp-Protocol-Version`. A **browser-based** NIP-98
  client that sends `Mcp-Protocol-Version` therefore fails preflight at `/mcp`
  today. Use `/account/mcp`, which reaches `handleAccountMcp` directly, or omit
  the header. Non-browser clients (CLI agents) never preflight and are
  unaffected.
- An `OPTIONS` that *does* carry `Authorization: Nostr …` is routed to the
  door and answered by `preflight()` (`account-mcp-http.ts:404`) **before any
  verification** — on that path the header is a routing selector only, and its
  signature is never checked. Do not read a 204 there as proof of auth.

## 2. The event

Kind **27235** (`NOSTR_AUTH_KIND`, `nostr-event.ts:61`), a NIP-01 event whose
`id` is `sha256` of the whitespace-free JSON array `[0, pubkey, created_at,
kind, tags, content]` and whose `sig` is BIP-340 Schnorr over the **32 raw
bytes** of that id, not its hex spelling (`nostr-event.ts:177`, `:209`).

| Field / tag | Rule | Enforced at |
| --- | --- | --- |
| `kind` | must be `27235` | `nostr-http-auth.ts:197` → `wrong_kind` |
| `pubkey` | 32-byte x-only key, **lowercase** hex, 64 chars. Uppercase is rejected, not normalized. | `nostr-event.ts:116` |
| `id` | lowercase hex, recomputed and compared **before** any curve math | `nostr-event.ts:206` |
| `sig` | 128 lowercase hex chars; BIP-340 verify | `nostr-event.ts:133` |
| `created_at` | `abs(now − created_at) ≤ 60 s` (`NIP98_MAX_SKEW_SECONDS`) | `nostr-http-auth.ts:203` → `expired` |
| `u` tag | **exact string equality** with the absolute URL the hub reconstructs | `nostr-http-auth.ts:215` → `url_mismatch` |
| `method` tag | present, case-insensitively equal to the request method | `nostr-http-auth.ts:224` → `method_mismatch` |
| `payload` tag | see §2.2 | `nostr-http-auth.ts:233` → `payload_mismatch` |
| `content` | ≤ 1024 chars; unused, send `""` | `nostr-event.ts:64` |
| tags | ≤ 20 tags, ≤ 8 elements each, ≤ 512 chars per element | `nostr-event.ts:66`–`:70` |

Tag lookup is **first-wins** on `tag[0]` (`tagValue`, `nostr-event.ts:227`); a
duplicate tag is not an error, since the whole tag array is signed anyway.

### 2.1 The `u` tag and the proxy foot-gun

`u` must equal `requestAbsoluteUrl(req)` (`nostr-http-auth.ts:152`) — scheme,
host, port, path, and query exactly as the hub sees them. So `/mcp` and `/mcp/`
are different URLs, and the query string counts.

The hub binds `127.0.0.1:1939` over plain HTTP; Tailscale Serve, cloudflared,
and Render terminate TLS at the edge, so `req.url` arrives as `http://…` while
the client signed `https://…`. The hub upgrades the scheme when
`X-Forwarded-Proto: https` is present **and** `layerOf` classified the request
as non-loopback (`nostr-http-auth.ts:157`) — a request that hits `:1939`
directly is never upgraded, so a forged XFP cannot replay a captured tailnet
event against the loopback listener. `X-Forwarded-Host` is **not** honored and
the stored `hub_origin` is never substituted: a proxy that rewrites the Host or
the path breaks every signature. The reference client sidesteps all of this by
signing inside `fetch` with the literal URL being fetched (`signing-fetch.ts`).

### 2.2 The `payload` tag

Symmetric and strict — this is the rule that refuses new clients most often:

| Request body | `payload` tag | Result |
| --- | --- | --- |
| empty | absent | accepted |
| empty | **present** | `payload_mismatch` — "must be absent when the body is empty" (`nostr-http-auth.ts:237`) |
| non-empty | absent | `payload_mismatch` (`null !== expected`) |
| non-empty | `sha256` hex of the **raw bytes** sent | accepted |
| non-empty | anything else | `payload_mismatch` (`nostr-http-auth.ts:245`) |

Hash the exact bytes on the wire, not a re-serialized copy. On the MCP door the
hub reads the body for every method **except** GET, HEAD, and DELETE
(`account-mcp-http.ts:407`), so a `DELETE` is verified against an *empty* body
and its event must carry **no** `payload` tag even if you sent one. (The
admin-route path differs: `admin-auth.ts:112` hashes the body for every method
except GET and HEAD, DELETE included.)

### 2.3 Freshness: one event, one request

Event ids are single-use. `NostrReplayCache.consume` records an id on first
sight and rejects it for `NIP98_REPLAY_TTL_MS` = `2 × 60 s + 1 s` = **121 000
ms** (`nostr-http-auth.ts:45`) — a compile-time constant, not an environment
variable, longer than twice the skew window so an event still inside ±60 s
cannot be replayed after eviction.

The burn happens **before** the `u` / `method` / `payload` checks
(`nostr-http-auth.ts:211`): **a failed request burns its id too.** Never retry
with the same header. The cache is a single module-level instance
(`defaultReplay`, `nostr-http-auth.ts:95`) shared by `/mcp`, `/account/mcp`,
and the admin routes — an id burned on one door is burned on all of them.

Because `created_at` has one-second resolution, two byte-identical requests in
the same second collide on id and the second is `replayed` — so add a random
`nonce` tag to every event. The hub does not read
`nonce`; it is covered by the id, which is the point. The reference client
treats it as mandatory (`nip98.ts:buildAuthEvent`).

## 3. Header encoding

```
Authorization: Nostr <base64(utf8(JSON.stringify(event)))>
```

The scheme match is `/^Nostr\s+(\S+)$/i` (`nostr-http-auth.ts:102`):
case-insensitive scheme, exactly one whitespace-separated token, no internal
whitespace or line folding. The token is decoded with
`Buffer.from(token, "base64url")` (`nostr-http-auth.ts:112`), and that decoder
is lenient — **standard base64 (`+`, `/`, `=` padding) and base64url (`-`, `_`,
unpadded) are both accepted** (verified empirically against the hub's runtime;
the reference client emits standard padded base64,
`nip98.ts:signAuthHeader`). The decoded bytes must be a JSON object passing
`parseNostrEvent`; anything else is `malformed_authorization` / `invalid_event`.
The decoder never throws — `Buffer.from` silently drops characters outside the
alphabet — so the "not base64url" branch (`:113`) is unreachable and a garbage
token instead decodes to junk bytes and fails at `JSON.parse` (`:118`), with
the same `malformed_authorization` code.

## 4. Streamable HTTP requirements

JSON-response-mode Streamable HTTP. Checks run in this order, so an auth
failure preempts a transport failure:

| # | Condition | Response |
| --- | --- | --- |
| 1 | auth (§2) | `401` + `WWW-Authenticate` (`account-mcp-http.ts:411`) |
| 2 | `DELETE` | `200`, empty body (`:418`) |
| 3 | method ∉ {POST, DELETE, OPTIONS} | `405`, `Allow: POST, DELETE, OPTIONS` (`:419`) |
| 4 | `Accept` lacking `application/json` **or** `text/event-stream` | `406` (`:436`) |
| 5 | `Content-Type` not containing `application/json` | `415` (`:447`) |
| 6 | body not JSON / not JSON-RPC 2.0 | `400`, code `-32700` (`:456`, `:463`) |
| 7 | `Mcp-Protocol-Version` present, unsupported, on a non-`initialize` batch | `400` (`:469`) |
| 8 | no requests in the batch (notifications only) | `202`, empty body (`:481`) |
| — | otherwise | `200`, one JSON-RPC response object; an array **only** when the batch held 2+ requests — a one-request array gets a bare object back (`:497`) |

**There are no sessions.** The hub never issues `Mcp-Session-Id` and never
reads one — the string "session" does not appear in the request path of
`account-mcp-http.ts`. Every POST is independently authenticated by its own
event and carries no server-side state: do not wait for a session header on
`initialize`, and do not send one (an unknown value is ignored, not 404'd).
`DELETE` is accepted and returns `200` purely for SDK compatibility; it tears
nothing down. `GET` is `405` — there is **no** server→client SSE stream, so a
client that opens the GET/SSE channel must tolerate that. Supported protocol
versions: `2025-11-25` (default), `2025-06-18`, `2025-03-26`, `2024-11-05`,
`2024-10-07` (`account-mcp-http.ts:49`).

## 5. What the pubkey gets you

`resolveNostrPrincipal` (`nostr-http-auth.ts:280`) maps `event.pubkey` → a hub
user via the `user_pubkeys` link table. An existing link always wins.

**Auto-provision.** When the key is unknown and
`PARACHUTE_NOSTR_AUTO_PROVISION` is `1` / `true` / `yes` (`admin-auth.ts:99`;
**default off**), the hub creates a key-only user: username `n` + the first 31
hex chars of the pubkey, unusable random password, `password_changed=1`, no
assigned vaults. Caveat — the **bootstrap sentinel**: if the users table is
empty (`getFirstAdminId(db) === null`) auto-provision is refused
(`nostr-http-auth.ts:303`), because an anonymous signer must never become the
hub's first account, which is its administrator. The same sentinel guards
grant-first provisioning (`grant-access.ts:193`). The normal onboarding is
therefore **grant-first**: an admin calls `grant-access` with the pubkey, which
creates the key-only user and one `user_vaults` row. That argument (and
`revoke-access`'s) takes **either** lowercase hex **or** an `npub1…` NIP-19
key, which is decoded to hex before anything is written (`nip19.ts`) — the
event `pubkey` field above stays hex-only.

**Coverage** (`resolveCoverage`, `account-mcp.ts:180`, `authKind: "nostr"`):

| Principal | Vaults | `create-vault` |
| --- | --- | --- |
| first admin / hub admin | every installed vault (`covered: "all"`) | yes |
| granted user | `user_vaults` ∩ installed, `read` verb required — fail-closed | no |
| freshly auto-provisioned key | none | no |

**The catalog is key-scoped.** `tools/list` returns hub-native tools filtered
by what this principal can actually call (`account-mcp.ts:439`) — `list-vaults`
always, `create-vault` only if it may create, `grant-access` /
`revoke-access` / `list-access` only if it can admin at least one covered vault
— concatenated with a live `tools/list` forwarded from a covered vault
(`listVaultModuleTools`). With zero covered vaults that second list is empty,
so an auto-provisioned key sees exactly one tool.

**The `vault` selector.** Every vault-shaped tool gets a `vault` string
property injected, added to the schema's `required` array for every tool
**except `query-notes`** (`injectVaultSelector`, `account-mcp-backend.ts:157`).

- `query-notes` with no `vault` fans out across every covered vault, returning
  `{ vaults_queried, results: [{ vault, notes | error }] }`; one failing vault
  becomes that vault's `error`, never a whole-call failure.
- Every other tool requires it: `callVaultModuleTool`
  (`account-mcp-backend.ts:315`) calls `coveredVault` (`:234`), which throws
  `invalid_vault` ("vault is required.") when absent and `vault_not_covered`
  when the name is outside coverage. The name is lowercased before matching.
  Both surface as JSON-RPC `-32602` with `data.error_type`.
- The vault-shaped catalog is **single-source, not merged**:
  `listVaultToolsUncached` (`account-mcp-backend.ts:200`) walks covered vaults
  highest-verb-first and returns the first `tools/list` that answers — it does
  not union them. So a tool advertised from your highest-verb vault may answer
  `Unknown tool` against a vault where you hold a lower verb.

## 6. Failure vocabulary

`NostrHttpAuthFailure` (`nostr-http-auth.ts:47`). Every member is constructed
with HTTP **401**; `translateAuthError` (`account-mcp-http.ts:378`) passes the
status through and renders `{"error":"invalid_token","error_description":…}`
plus a `WWW-Authenticate: Bearer resource_metadata="…"` challenge naming
`/.well-known/oauth-protected-resource/mcp` for `/mcp` and `…/account/mcp` for
the legacy path (`challengePrmPath`, `:133`).

| Code | Status | Meaning |
| --- | --- | --- |
| `missing_authorization` | 401 | no `Authorization` header |
| `malformed_authorization` | 401 | header is not `Nostr <token>`, or the decoded bytes are not JSON (`nostr-http-auth.ts:118`). Never raised for bad base64 as such — see §3. |
| `invalid_event` | 401 | failed NIP-01 shape/bounds validation |
| `bad_signature` | 401 | id ≠ hash of payload, or Schnorr verify failed |
| `wrong_kind` | 401 | `kind` ≠ 27235 |
| `expired` | 401 | `created_at` outside ±60 s |
| `replayed` | 401 | event id already consumed (≤ 121 s ago) |
| `url_mismatch` | 401 | `u` tag ≠ the URL the hub reconstructed |
| `method_mismatch` | 401 | `method` tag absent or ≠ request method |
| `payload_mismatch` | 401 | body-hash rule broken in either direction (§2.2) |
| `unknown_pubkey` | 401 | key not linked, auto-provision off, linked user gone, or bootstrap sentinel |
| `pubkey_taken` | 401 | provisioning raced another binding of the same key |

On the **admin** routes one more status exists *after* authentication succeeds:
a hub-admin principal is granted the required scope outright, anyone else must
carry it in their `vault:<name>:<verb>` scope list or gets **403** `token
missing required scope` (`admin-auth.ts:129`).

## 7. Worked example

Hub at `https://hub.example.ts.net`. Placeholders below are not real keys.

```json
{
  "id": "3f2a…64 hex…",
  "pubkey": "0000…64 hex placeholder…",
  "created_at": 1756742400,
  "kind": 27235,
  "tags": [
    ["u", "https://hub.example.ts.net/mcp"],
    ["method", "POST"],
    ["nonce", "9c1d4b0a7e5f2a3b8c6d0e1f2a3b4c5d"],
    ["payload", "b1946ac9…sha256 hex of the body bytes…"]
  ],
  "content": "",
  "sig": "0000…128 hex placeholder…"
}
```

```sh
URL=https://hub.example.ts.net/mcp
LIST='{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
QUERY='{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"query-notes","arguments":{"vault":"uni","search":"nip98","limit":5}}}'

# Run with either body. Each invocation signs a FRESH event; never reuse a header.
BODY="$LIST"     # or: BODY="$QUERY" — drop "vault" to fan out across all covered vaults
curl -sS "$URL" \
  -H "Authorization: Nostr $(python3 sign.py "$URL" POST "$BODY")" \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -H 'User-Agent: my-agent/1.0' \
  --data-raw "$BODY"
```

`sign.py` — the serialization, hash, and header, exactly:

```python
import base64, hashlib, json, os, secrets, sys, time
url, method, body = sys.argv[1], sys.argv[2].upper(), sys.argv[3].encode()

tags = [["u", url], ["method", method], ["nonce", secrets.token_hex(16)]]
if body:                                   # tag ABSENT when the body is empty
    tags.append(["payload", hashlib.sha256(body).hexdigest()])

sk = bytes.fromhex(os.environ["NOSTR_SECRET_KEY"])   # never hardcode
ev = {"pubkey": schnorr_pubkey(sk),        # 32-byte x-only, lowercase hex
      "created_at": int(time.time()), "kind": 27235, "tags": tags, "content": ""}
# NIP-01 canonical form: no whitespace, non-ASCII passes through literally.
ser = json.dumps([0, ev["pubkey"], ev["created_at"], ev["kind"], ev["tags"],
                  ev["content"]], separators=(",", ":"), ensure_ascii=False)
ev["id"] = hashlib.sha256(ser.encode()).hexdigest()
ev["sig"] = schnorr_sign(sk, bytes.fromhex(ev["id"])).hex()  # BIP-340, raw id bytes
print(base64.b64encode(json.dumps(ev).encode()).decode())
```

`separators=(",", ":")` and `ensure_ascii=False` are load-bearing: with them
this is byte-identical to the hub's `JSON.stringify` (cross-checked against
`nostrEventId`). `schnorr_pubkey` / `schnorr_sign` are your BIP-340 library's —
Python has none in the stdlib; `coincurve` ≥ 18 or `secp256k1` provide them,
and that binding is the one part of this snippet not exercised here. In JS use
`nostr-tools/pure`'s `finalizeEvent`, which is what `@openparachute/mcp` does.

**Gotcha, observed not enforced:** a hub fronted by Cloudflare rejects Python
`urllib`'s default `User-Agent` (`Python-urllib/3.x`) before the request ever
reaches the hub — an opaque 403 with an HTML body, neither a hub response nor a
NIP-98 failure. Send a real `User-Agent`. Edge policy, not hub code.

## 8. Non-goals

This is not OAuth. NIP-98 never goes through `/oauth/authorize`, issues the
caller no token, registers no client, asks for no consent — the signature *is*
the credential, one per request. (The hub does mint a short-lived
`vault:<name>:<verb>` bearer *internally*, per call, to make the hop to the
vault daemon — `mintVaultMcpToken`, `account-mcp-backend.ts:65`. That
credential is never issued to the caller; it travels only the loopback hop to
the vault daemon (`postVaultMcp`, `account-mcp-backend.ts:139`–`:145`).)

Nothing here narrows or composes scopes; a NIP-98 principal's authority is
entirely its `user_pubkeys` link and its `user_vaults` rows.

The hub's OAuth 2.1 door is a separate contract on the same URL, keyed by an
`aud=account` bearer: [`oauth-scopes.md`](./oauth-scopes.md) (scope grammar and
registry), [`hub-as-issuer.md`](./hub-as-issuer.md) (the single-issuer rule),
[`oauth-dcr-approval.md`](./oauth-dcr-approval.md) (dynamic registration and
operator approval). Use OAuth for anything user-delegated or browser-mediated;
use NIP-98 for key-holding agents.
