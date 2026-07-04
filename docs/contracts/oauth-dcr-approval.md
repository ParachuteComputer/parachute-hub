> Moved from parachute-patterns/patterns/oauth-dcr-approval.md (2026-07-04) — see the patterns-archive decision. This repo enforces this contract.

# OAuth DCR approval lifecycle

## Convention

The hub is the OAuth issuer ([`hub-as-issuer.md`](./hub-as-issuer.md)) and
the gatekeeper for which OAuth clients exist on the install. **Every
public Dynamic Client Registration (RFC 7591) lands as `pending`.** A
pending client cannot exchange auth codes; it cannot reach `/oauth/token`.
The operator must explicitly grant approval via one of five paths before
the client can complete a flow. Same-origin SPAs (running at the hub's
origin) auto-approve when the operator's session cookie is present and
the request's `Origin` matches the issuer. Cross-origin SPAs (or
fresh-cache scenarios where the session isn't on the registration POST)
hit an inline approve button on the `/oauth/authorize` pending page —
one click and the flow continues. The SPA approve page
(`/admin/approve-client/<id>`) is a sibling surface for deep-link / share-
link / direct-nav cases; it optionally resumes a parked OAuth flow via
`return_to`.

The authoritative implementation is in
[`parachute-hub/src/oauth-handlers.ts`](https://github.com/ParachuteComputer/parachute-hub/blob/main/src/oauth-handlers.ts)
(`handleRegister`, `handleApproveClientPost`, `originMatchesIssuer`) and
[`parachute-hub/src/clients.ts`](https://github.com/ParachuteComputer/parachute-hub/blob/main/src/clients.ts)
(`approveClient`, `listClientsByStatus`). The browser surface is
[`parachute-hub/src/oauth-ui.ts`](https://github.com/ParachuteComputer/parachute-hub/blob/main/src/oauth-ui.ts)
(`renderApprovePending`). The CLI surface is
[`parachute-hub/src/commands/auth.ts`](https://github.com/ParachuteComputer/parachute-hub/blob/main/src/commands/auth.ts)
(`auth pending-clients`, `auth approve-client`, `auth revoke-grant`).
This doc captures the lifecycle and the *why*; if it disagrees with
the code, the code wins and this doc is wrong.

## Lifecycle

Two related-but-distinct lifecycles run alongside each other: the
**client** lifecycle (does this `client_id` exist on this hub, and is it
allowed to complete a flow?) and the **grant** lifecycle (has the
operator consented to *this* client requesting *these* scopes?). The
diagram conflated them in an earlier draft; they're separate.

### Client lifecycle

```
            register (no auth)
public DCR ─────────────────────► pending
                                     │
                                     │ operator demonstrates authority
                                     ▼
                                 approved        (terminal)
```

- **`pending` is the default** for any client registered via public DCR
  (`POST /oauth/register` with no auth headers).
- **`pending` → `approved` is one-way and operator-driven.** No automatic
  promotion from a passive event (time, request volume, anything).
- **`approved` is terminal in the type system.** `ClientStatus` is
  `"pending" | "approved"` — there is no `removed` status. Client
  deletion is a row-delete on the `clients` table, performed by direct
  `hub.db` edit (no `parachute auth` command exists for full client
  deletion yet — file an issue if needed).
- A pending client hitting `/oauth/token` gets `invalid_client` per RFC
  6749. A pending client hitting `/oauth/authorize` gets the
  human-readable "App not yet approved" page (with or without an inline
  approve button — see "Inline approve button" below).

### Grant lifecycle

```
                                       parachute auth revoke-grant
operator consents at /oauth/authorize ─────────────────────────────► (no grant row)
                  │                                                       │
                  ▼                                                       │
              grant row in `grants` table                                 │
              (user_id, client_id, scopes)                                │
                  ▲                                                       │
                  └─────── operator re-consents on next /oauth/authorize ─┘
```

- **A grant** is a row in the `grants` table keyed by
  `(user_id, client_id)`, recording the scopes the operator approved.
- **`parachute auth revoke-grant <client_id>`** deletes the grant row
  (see [`grants.ts:revokeGrant`](https://github.com/ParachuteComputer/parachute-hub/blob/main/src/grants.ts)).
  It does **not** change the client's status — the client stays
  `approved`. The next time the operator runs the OAuth flow with that
  client, `/oauth/authorize` re-prompts for consent and a fresh grant
  row is created.
- **Revoking a grant does not invalidate already-issued tokens.** Token
  revocation is a separate operation via `/oauth/revoke` (and any future
  CLI wrapper).

### Revocation, distinguished

- **Client revocation** is operator-explicit via direct `hub.db` row
  delete on the `clients` table (no `parachute auth` command exists for
  client deletion). After deletion the `client_id` no longer exists; any
  use of it gets `invalid_client`.
- **Grant revocation** uses `parachute auth revoke-grant <client_id>`
  and removes the consent grant — the client stays approved; the next
  OAuth flow re-prompts consent.

## Four paths to `approved`

| Path | Trigger | Code | Originating PR |
|---|---|---|---|
| **Operator-bearer header** | `Authorization: Bearer <hub-admin-token>` (with `hub:admin` scope) on `POST /oauth/register` | [`oauth-handlers.ts:handleRegister`](https://github.com/ParachuteComputer/parachute-hub/blob/main/src/oauth-handlers.ts) — bearer branch | [hub#74](https://github.com/ParachuteComputer/parachute-hub/issues/74) |
| **Same-origin session cookie + matching Origin** | Hub session cookie present on `POST /oauth/register` AND request `Origin` matches `deps.issuer` | [`oauth-handlers.ts:handleRegister`](https://github.com/ParachuteComputer/parachute-hub/blob/main/src/oauth-handlers.ts) — cookie branch + `originMatchesIssuer` | [hub#200](https://github.com/ParachuteComputer/parachute-hub/pull/200) |
| **Inline approve button** | Operator browser navigates to `/oauth/authorize` for a pending client; session detected → approve form rendered → operator clicks → `POST /oauth/authorize/approve` | [`oauth-handlers.ts:handleApproveClientPost`](https://github.com/ParachuteComputer/parachute-hub/blob/main/src/oauth-handlers.ts) + [`oauth-ui.ts:renderApprovePending`](https://github.com/ParachuteComputer/parachute-hub/blob/main/src/oauth-ui.ts) | [hub#209](https://github.com/ParachuteComputer/parachute-hub/pull/209) |
| **SPA approve page** | Operator navigates to `/admin/approve-client/<id>` in the hub SPA (deep-linked from `/oauth/token`'s `approve_url`, the unauth pending-client share-link, or direct nav). One-click → `POST /api/oauth/clients/<id>/approve`. Optionally resumes a parked OAuth flow via `return_to` (see "SPA approve page (two cases, one route)" below). | [`admin-clients.ts:handleApproveClient`](https://github.com/ParachuteComputer/parachute-hub/blob/main/src/admin-clients.ts) + [`web/ui/src/routes/ApproveClient.tsx`](https://github.com/ParachuteComputer/parachute-hub/blob/main/web/ui/src/routes/ApproveClient.tsx) | [hub#74](https://github.com/ParachuteComputer/parachute-hub/issues/74) + workstream D (AUDIT-UI-UX §5 row D) |
| **CLI** | `parachute auth approve-client <id>` (operator with shell access to the hub install) | [`commands/auth.ts`](https://github.com/ParachuteComputer/parachute-hub/blob/main/src/commands/auth.ts) + [`clients.ts:approveClient`](https://github.com/ParachuteComputer/parachute-hub/blob/main/src/clients.ts) | [hub#74](https://github.com/ParachuteComputer/parachute-hub/issues/74) |

The five paths exist because the operator demonstrates authority in
different contexts and the right friction profile is different in each:

- **Operator-bearer** — scripted / automation. The install path uses this
  so `parachute install vault` can self-register a first-party module
  without a human follow-up. Trust comes from possession of an
  operator-token with `hub:admin` scope.
- **Cookie + Origin** — operator's own SPA on the hub's own origin.
  Requiring approval here is friction without benefit: the operator is
  *already* the operator, the SPA is *their* SPA. Trust comes from the
  session cookie + the same-origin gate (CSRF defense).
- **Inline button** — operator's browser, pending client (cross-origin
  SPA, fresh cache, redirect_uri changed). The friction event is rare
  but real. Trust comes from triple-belt: CSRF token + active session +
  Origin/Referer match.
- **SPA approve page** — operator's browser, deep-linked from
  `/oauth/token`'s `approve_url`, the unauth pending-client share-link,
  or a "share this with another admin" handoff. The same UI as inline
  but reachable as a standalone admin route. Optionally resumes a
  parked OAuth flow (workstream D) when given a `return_to` query
  parameter; without one, dead-ends on a "return to the app" success
  message for the share-link case. Trust comes from the `host:admin`
  Bearer (minted from the session cookie at `/admin/host-admin-token`).
- **CLI** — headless / multi-machine / SSH-only contexts. Trust comes
  from shell access to the hub install (= already trusted).

## Security model

Each path has a different gate, sized to the context:

- **Operator-bearer.** Bearer token validated as `hub:admin`-scoped via
  the hub's normal scope check (see [`oauth-scopes.md`](./oauth-scopes.md)
  for scope semantics). If a bearer is presented but invalid or
  insufficiently-scoped, registration fails loudly with the RFC 6750
  shape — not a silent fall-through to `pending`. A caller who tried to
  authenticate but failed wants to know why.
- **Cookie + Origin.** Three-belt defense:
  1. Live (un-expired) session row keyed by the `parachute_hub_session`
     cookie.
  2. Request `Origin` (or `Referer` fallback) matches `deps.issuer` —
     `originMatchesIssuer`. URL.origin compares scheme + host + port.
     Opaque-origin requests (sandboxed iframes, `data:`/`file:`
     documents) send `Origin: null` literally; this is parsed as a
     malformed URL and rejected with the same shape as cross-origin.
  3. The session cookie itself is `SameSite=Lax`, so the browser blocks
     it from cross-site POSTs in the first place. The `originMatchesIssuer`
     check is the server-side belt for the cases where Lax doesn't cover
     us (curl probes, privacy-extension Origin stripping). A request
     with neither `Origin` nor `Referer` is treated as suspicious and
     rejected.
- **Inline button.** Same triple-belt as the cookie path, plus a CSRF
  token (double-submit cookie). The token is minted at GET render time
  and embedded in the form. Plus `return_to` is validated as a
  hub-relative `/oauth/authorize?...` path — open-redirect defense, plus
  it prevents the endpoint being used as a generic redirect-after-approve
  gadget. The operator sees `client_id`, `client_name`, `redirect_uris`,
  and the requested scopes before clicking.
- **SPA approve page.** Same Bearer gate as every other admin endpoint:
  `parachute:host:admin` scoped JWT, minted from the operator's session
  cookie at `/admin/host-admin-token`. The cookie itself rides
  `SameSite=Lax`; the mint endpoint is same-origin only. The browser
  surface reuses the SPA's auth boundary — there's no new gate to
  reason about, just a new client of the existing one.
- **CLI.** Assumes the operator has shell access to the hub install.
  The threat model treats shell access as already trusted — anything
  the CLI can do, anything else on the same shell can do. The CLI path
  exists to *enable* operators (headless boxes, scripts), not to gate
  them.

The shared invariant: **a client only becomes `approved` after the
operator has demonstrated authority via one of the five paths.**
There is no path that promotes a client without an explicit operator
action.

## SPA approve page (two cases, one route)

`/admin/approve-client/<id>` serves two distinct flows distinguished
purely by the presence of a `return_to` query parameter. Both share the
same route, the same auth gate, the same approve action, the same
audit-log line. They diverge only on what happens after the click.

### Case 1 — OAuth resume (`return_to` present)

```
caller has a parked OAuth flow
  │
  ▼
operator navigates to /admin/approve-client/<id>?return_to=<authorize-url>
  │
  ▼
SPA validates return_to with isSafeReturnTo (starts with /, doesn't start with //)
  — intentionally broader than the server gate so future non-/oauth/authorize
  resume targets can be wired without an SPA change. Server is the authority.
  │
  ▼
operator clicks Approve
  │
  ▼
SPA POSTs { return_to } to /api/oauth/clients/<id>/approve
  │
  ▼
server runs isSafeAuthorizeReturnTo (same gate as POST /oauth/authorize/approve)
  │
  ├── valid → response carries redirect_to
  │   │
  │   ▼
  │   SPA re-validates same-origin, window.location.assign(redirect_to)
  │   │
  │   ▼
  │   hub-server's /oauth/authorize handler finishes the parked flow
  │
  └── invalid → response omits redirect_to (silently dropped)
      │
      ▼
      SPA falls back to case 2's dead-end success state
```

**Validation gate.** Same shape as the inline button's `return_to`:
hub-relative path, must start with `/`, must not start with `//`,
and the server-side gate additionally requires `/oauth/authorize?`
prefix (open-redirect defense + "this endpoint isn't a generic redirect
gadget"). The SPA gates client-side too as belt-and-suspenders; the
server is the authoritative gate.

**Re-approve race tolerance.** When the page loads and the client is
already approved (parallel session, automation, page reload), the SPA
auto-redirects to `return_to` immediately rather than rendering the
"already approved" dead-end — the parked OAuth flow can finish without
a redundant operator click.

**Server response shape.** `{ client_id, status: "approved",
already_approved, redirect_to? }`. `redirect_to` is present iff the
caller's `return_to` passed the gate. A bad / missing `return_to` drops
`redirect_to` off the response but DOES NOT fail the approve — the
client is now approved either way; the SPA falls back to case 2.

### Case 2 — Share link / direct nav (no `return_to`)

```
operator opens /admin/approve-client/<id>
  (from /oauth/token's approve_url, the unauth pending-client share-link,
   or direct browse-to-URL)
  │
  ▼
operator clicks Approve
  │
  ▼
SPA POSTs (no body) to /api/oauth/clients/<id>/approve
  │
  ▼
server omits redirect_to from the response
  │
  ▼
SPA renders "Approved. Return to the app that sent you here and retry."
```

The share-link case is the original pre-D shape. The operator opened
this from another tab / device / browser; the goal is "close this and
return to the app that sent you," not "navigate around the hub SPA."
Deliberately no auto-redirect.

### Why two cases on one route

The alternative — split into two routes — was considered and rejected:

- The action (approve client `<id>`) is the same; the auth gate is the
  same; the audit-log line is the same. Splitting the route would
  duplicate the surface area without changing the behaviour.
- The discriminator (`return_to` presence) is already in the URL. URL-
  parameter-as-flag is the simplest possible API.
- Future flows can adopt the resume case without coordinating a new
  route — they just append `?return_to=<their-authorize-url>` to the
  existing deep link.

### When to use which

| Caller | Case | Why |
|---|---|---|
| `/oauth/token` `approve_url` (currently surfaced to dead-end on the SPA) | 2 | The deep link is opened from a different origin (the caller's app). The operator's natural action is to close the tab and retry on the caller side — no OAuth flow is parked in this browser. A future revision could switch this caller to case 1 by appending `?return_to=` to the `approve_url`, but D deliberately did not flip the existing callsite — that's a separate UX call. |
| `/oauth/authorize` (pending client, signed-in operator) | (not this route — uses inline button at the authorize URL itself) | Inline resume already works post-rc.38; no reason to bounce to the SPA. |
| `/oauth/authorize` (pending client, unauth) | (not this route — uses sign-in CTA at the authorize URL itself; post-login the operator hits the inline button) | Same as above. |
| "Share this link with an admin" deep link (from the unauth pending-client page) | 2 | The admin clicking the link is not the operator who started the OAuth flow. No flow to resume. |
| Future: a flow that prefers the SPA's richer details over the inline button | 1 | Caller appends `?return_to=<authorize-url>` to the deep link. SPA approves AND resumes in one click. |

Workstream D added the case-1 affordance but did NOT change any existing
callsite to use it. Future flows that prefer the SPA approve UI over
the inline button can opt in by passing `return_to` — the existing
share-link case continues to work unchanged.

## The deliberate non-fix: cross-origin auto-approve

The interesting part of this pattern is what it *doesn't* do. A
cross-origin SPA — the agent's container UI talking to a tailnet hub,
or notes-via-cloudflare talking to the same — cannot auto-approve via
the cookie path. The "fix" looks straightforward (add CORS headers,
let the cookie ride) and was repeatedly tempting; we explicitly chose
not to ship it.

Four browser/policy gaps compound:

1. **`SameSite=Lax`** on the session cookie blocks the cookie from
   cross-origin POSTs by browser policy. This is a deliberate cookie
   property, not a bug.
2. **No CORS** on `/oauth/register` — no `Access-Control-Allow-Origin`,
   no `Access-Control-Allow-Credentials`. Adding them would invite
   third-party origins into the registration surface.
3. **No OPTIONS preflight** handler on `/oauth/register`. A
   credentialed cross-origin POST would preflight and fail.
4. **`originMatchesIssuer`** explicitly rejects cross-origin `Origin`
   values as a CSRF defense — even if the cookie *did* arrive, the
   server-side belt would reject the request.

Four options were considered (2026-05-08 design conversation):

- **A1 — first-party origin allowlist alone.** Add a list of trusted
  origins; if `Origin` matches one, treat as same-origin for the cookie
  check. **Eliminated:** doesn't actually work. The cookie's
  `SameSite=Lax` blocks the cookie *before* the server-side check runs.
  The allowlist would never see a cookie to validate.
- **A2 — second cookie with `SameSite=None; Secure` for DCR.**
  Mint a separate cookie with relaxed cross-site policy, scoped only
  to the DCR endpoint. Works in principle. **Costs:** expands the
  cookie surface (now there are two session-equivalent cookies),
  breaks HTTP loopback dev (Secure requires HTTPS), broader CSRF
  target (cross-site POSTs can ride the new cookie even with the
  origin allowlist on top).
- **A3 — same-origin relay popup.** SPA opens a hub-origin popup, the
  popup does the registration with the normal cookie (now same-origin),
  the popup `postMessage`s the `client_id` back. Robust to future
  browser changes, no new cookie surface. **Costs:** moderate code
  (popup orchestration on both sides), popup UX (can be blocked, can
  be confusing), still asynchronous on first run.
- **A4 — inline approve button on `/oauth/authorize` for pending
  clients with operator session.** The cross-origin DCR still leaves
  the client `pending`. The operator's browser then navigates the
  OAuth flow normally; the pending-client page detects their session
  and offers a one-click approve. **Picked.**

A4 won because:

1. **The friction event is rare.** Operators only see the approve
   button on first registration of a fresh client — browser cache
   clear, redirect_uri change, fresh device, new SPA. Not on every
   load (SPAs cache `client_id` in localStorage; see "For SPA
   developers" below). One click on a rare event is a fine ceiling.
2. **The security model is unchanged.** A4's inline approval requires
   the same operator authority as the CLI approve. We're not weakening
   the gate; we're just rendering it where the operator already is.
3. **Small code surface.** Roughly 50 lines in the handler plus a
   form section in the existing pending-client page, plus tests.
4. **Doesn't depend on browser policy** that may tighten further.
   `SameSite=Lax` and CORS rules are moving target; A4 is independent
   of both.

If a future scenario justifies cross-origin auto-approve — e.g.,
agent deployed at a separate hostname with high client-registration
churn — A2 or A3 can be layered on top of A4 without removing it.
A4 is the floor; the others would be additive.

[hub#201](https://github.com/ParachuteComputer/parachute-hub/issues/201)
tracked the original cross-origin auto-approve attempt and is closed
as deferred; this section is the canonical record of why.

## For SPA developers

- **Same-origin SPA** (your SPA loads from the hub's origin — e.g.
  Notes at `<hub>/notes/`): no special handling required. `fetch`
  defaults send the cookie. Just `POST /oauth/register` normally; the
  client lands `approved` if the operator's logged in.
- **Cross-origin SPA** (your SPA at a different origin): expect the
  inline approve button on the operator's first run. Don't try to
  bypass it. **Don't add `credentials: 'include'`** thinking it solves
  the problem — it doesn't (see the deferred section above; the gates
  are deeper than CORS).
- **Either way: cache your `client_id` in localStorage.** Re-registering
  on every page load both wastes a round-trip and re-triggers the
  approve gate. Re-register only when `redirect_uri` changes (e.g.
  the SPA moved hosts).

## For operators

- **First time you link an SPA to a vault**, expect either silent
  auto-approve (same-origin, you're logged in) or a one-click approve
  page.
- **"App not yet approved" with a button** → that's the inline approve
  UX. Review the `client_id` / `client_name` / `redirect_uris` / scopes
  shown, then click "Approve and continue."
- **"App not yet approved" without a button** → you're not logged into
  the hub in this browser. Visit `/admin/login`, sign in, then retry
  the SPA — or use the CLI path.
- **Headless contexts**: `parachute auth approve-client <id>`. List
  pending clients with `parachute auth pending-clients` to find the
  id.
- **Revoke when needed**: `parachute auth revoke-grant <client_id>` —
  removes the consent grant so the next flow re-prompts. To delete
  the client entirely, edit `hub.db` directly (no CLI command for full
  deletion yet — issue if needed).

## Where this applies

- **`parachute-hub`** — implements all four paths and the lifecycle.
  Single source of truth for client status.
- **`parachute-vault`** — Phase 0+1 issues OAuth on behalf of the hub
  (see [`hub-as-issuer.md`](./hub-as-issuer.md)) but does not run DCR
  itself. Vault-level vault-token issuance is a separate path and is
  not gated by this approval flow.
- **First-party modules** (vault, scribe, agent, notes) — register
  via the operator-bearer path during `parachute install <svc>`. They
  never see `pending`.
- **Third-party SPAs** — register via public DCR. They start
  `pending`. Operator promotes via one of the four operator-driven
  paths (cookie auto-approve, inline button, SPA approve page, or
  CLI).

## Open questions

- **Re-approval flow on `redirect_uri` rotation.** Today an SPA that
  changes its `redirect_uri` re-registers (new `client_id`, new
  approval round). A first-class "update redirect_uri" flow without
  re-approval is plausible but not built. Defer until needed.
- **Auto-revoke on extended idle.** No automatic revocation today. If
  a client doesn't successfully complete a flow within N days of
  approval, do we revoke? Probably not (the friction event of
  re-approving outweighs the security win for installs with low
  churn), but it's an open question for cloud deployments.
- **Multi-operator approval.** Today the install has one operator.
  Multi-human team setups (post-2026) may want
  approval-requires-quorum. Out of scope for now; flagged for the
  multi-human governance bump (see
  [`governance.md`](./governance.md)'s "Open questions").

## Implementing changes

- [hub#74](https://github.com/ParachuteComputer/parachute-hub/issues/74)
  — base approval gate. Public DCR lands `pending`; operator-bearer
  and CLI paths land `approved`.
- [hub#199](https://github.com/ParachuteComputer/parachute-hub/issues/199)
  — design issue for same-origin auto-approve via session cookie
  (closed by #200).
- [hub#200](https://github.com/ParachuteComputer/parachute-hub/pull/200)
  — same-origin auto-approve via session cookie + Origin match.
  Adds the cookie branch to `handleRegister` and the
  `originMatchesIssuer` helper.
- [hub#201](https://github.com/ParachuteComputer/parachute-hub/issues/201)
  — cross-origin auto-approve original design. Closed; see "The
  deliberate non-fix" above.
- [hub#208](https://github.com/ParachuteComputer/parachute-hub/issues/208)
  — design issue for the inline approve button (closed by #209).
- [hub#209](https://github.com/ParachuteComputer/parachute-hub/pull/209)
  — inline approve button implementation. Adds
  `handleApproveClientPost` + the form section in
  `renderApprovePending`.
- [paraclaw#140](https://github.com/ParachuteComputer/paraclaw/issues/140),
  [paraclaw#144](https://github.com/ParachuteComputer/paraclaw/pull/144)
  — agent SPA companion issues; closed when A4 (inline button) was
  chosen, since cross-origin SPA-side `credentials: 'include'` doesn't
  help.
- **hub workstream D** (post-rc.38) — SPA approve page learns to
  resume parked OAuth flows via `?return_to=<authorize-url>`. Adds
  the optional JSON body field to `POST /api/oauth/clients/<id>/approve`
  and the `redirect_to` echo, plus client-side validation +
  `window.location.assign` on the SPA. The share-link case is
  deliberately preserved — calls without `return_to` keep their
  dead-end behaviour. Source: AUDIT-UI-UX.md §5 row D.
