# Optional idle screen-lock PIN for the hub admin UI

**Status:** implemented · **Date:** 2026-06-17 · **Scope:** `@openparachute/hub`

A phone-style screen lock for the hub admin UI: an **optional** operator PIN
that locks the **whole** admin surface, **auto-locks after idle** (and on a
fresh load), and unlocks with the PIN into a frictionless working window that
activity keeps alive. Off by default — absent PIN = today's behavior, exactly.

This is the **hub-layer realization of channel issue #80** (step-up /
protection for a sensitive surface). Surfaces (notes-ui, my-vault-ui, etc.) can
add their own PIN independently; this guards the hub's own admin portal.

## Threat model — what this guards, and what it deliberately doesn't

The hub admin UI is reachable remotely once `parachute expose` is up (Tailscale
/ Cloudflare). The password-login session cookie lasts 24h, so an **unattended
or grabbed browser session is a standing admin console** — vault provisioning,
token minting, user management, module config, all one click away. That is the
risk this closes: a left-logged-in or shoulder-surfed remote admin session.

**Honest limit — this is a web/UI-layer guard for the EXPOSED portal.** It does
**NOT** protect against someone with a **shell** on the box. A shell user reads
`~/.parachute/operator.token` or the vault DB directly and bypasses the hub
entirely. That's an OS concern: disk encryption, a locked OS screen, SSH-key
hygiene. The lock shuts the **portal** door — the one the internet can reach —
which is the point. We state this in the Settings UI copy too, so operators
don't mistake it for at-rest protection.

## The single chokepoint (why the lock cascades for free)

The admin SPA and **every** module config UI obtain their working Bearer from
one of four cookie-gated mint endpoints, all sharing the identical
`parseSessionCookie → findSession → [isFirstAdmin] → signAccessToken` shape:

| Endpoint | Bearer for |
|---|---|
| `GET /admin/host-admin-token` | the admin SPA itself (`parachute:host:admin/auth`) |
| `GET /admin/channel-token` | channel chat + config UIs |
| `GET /admin/vault-admin-token/<name>` | per-vault admin SPA (`vault:<name>:admin`) |
| `GET /admin/module-token/<short>` | generic module config UI (`<short>:admin`) |

Inserting **one gate** — `admin-lock.ts:requireUnlocked(db, sessionId)` — into
each handler makes the lock cascade to the **entire admin surface with no
per-module changes**. When the session is locked, every mint returns **`423
Locked`**; the SPA shows the lock screen, and every module admin API fails
closed (no Bearer). This is why a single lock over the whole surface is both
simpler AND safer than per-action gating — per-action would friction-up
configuration, which is exactly the dangerous stuff we most want behind one
gate.

## CRITICAL boundary — the OAuth issuer is untouched

The lock gates **only** the admin-token mint path. It must NOT — and does not —
affect the OAuth flow for third-party clients (surfaces, claude.ai connectors,
etc.). `/oauth/authorize`, `/oauth/token`, `/oauth/register`, `/oauth/revoke`,
`/.well-known/*`, JWKS, the services catalog, and all third-party token
issuance work **unchanged while the admin UI is locked**. A surface OAuth'ing
in never hits a `/admin/*-token` endpoint, so it never sees the lock.

Proof: `src/__tests__/admin-lock.test.ts` →
*"a third-party client completes authorize→token while the admin session is
locked"* sets a PIN, asserts `GET /admin/host-admin-token` returns 423, then
runs a full PKCE `authorize → token` flow that succeeds and yields a valid
`vault:default:read` JWT.

### Also untouched: friend `/account/*` surfaces

The lock is the **first admin's** screen lock for the **admin console**, keyed
per-session. The four gated mints are all `isFirstAdmin`-gated, so the lock only
ever affects the admin's own session. The assigned-user (friend) path —
`POST /account/vault-admin-token/<name>` and `/account/vault-token/<name>` — is
a different principal on the `/account/*` home and is **not** gated: the admin's
idle lock must not lock another user out of their own assigned vault (they never
set that PIN). Intentional scoping, not an oversight.

## Unlock state — per-session, in-memory, "unlocked-until"

The simplest workable model (chosen over a client-held unlock token — no signing
/ replay surface to manage, and a hub restart naturally re-locks):

- A successful PIN unlock records `unlockedUntil = now + idle` for the session
  id (the cookie value) in a **process-local Map** (`src/admin-lock.ts`).
- A session is **unlocked** iff a future `unlockedUntil` exists. Genuine **user
  activity** — the SPA's debounced `/heartbeat`, fired on pointer/key/scroll —
  **slides** the window forward by the idle interval. Token mints are a pure
  check and do **not** slide it: the SPA polls some endpoints in the background
  (e.g. the version badge every 30s), each re-minting a Bearer, so an
  extend-on-mint window would never let an idle-but-open tab lock. The heartbeat
  is the one signal that means "a human is here."
- **Locked** when: no PIN set (feature off — always allowed); PIN set + no
  unlock recorded (fresh load / first visit); PIN set + the window is in the
  past (idle-expired); a hub restart wiped the Map (re-lock — a feature).
- The unlock state is **never persisted** and **never in the cookie**. A stolen
  cookie alone can't carry an unlocked window; the attacker still needs the PIN.

Default idle window: **15 minutes** (operator-configurable 1 min – 24 h, clamped).

## PIN storage

- **argon2id** hash (`@node-rs/argon2` — the same family the hub already uses
  for passwords + TOTP backup codes), stored in `hub_settings` under
  `admin_lock_pin_hash`. **Never plaintext, never in the session/cookie.** The
  hash sits at the same operator-local trust boundary as the password hashes +
  signing keys already in `hub.db`.
- **Absent row = feature OFF = today's behavior exactly.** No lock, nothing
  changes. No DB migration needed — `hub_settings` is a generic KV table; the
  feature only adds two keys (`admin_lock_pin_hash`, `admin_lock_idle_seconds`).
- PIN format: 4–12 digits (a phone-lock affordance). The real defense is the
  idle window + a brute-force limiter, not PIN entropy — the session is already
  password-authenticated; this is a second, idle-bounded, convenience-grade gate.

## Set / change / remove (the chicken-and-egg)

All under `/api/admin-lock*`, session-cookie-gated to the **first admin**
(same audience as the token mints) + CSRF-belted (double-submit `__csrf` token
**and** the same-origin Origin belt the `/admin/connections` mutations use).
These manage the lock itself, so they are **not** behind the lock gate — you
must be able to unlock + set the PIN even when the surface is locked.

| Route (POST unless noted) | Behavior |
|---|---|
| `GET /api/admin-lock` | status: `{ configured, locked, idle_seconds, unlock_seconds_remaining }` |
| `/set` | set the **first** PIN — allowed when none configured; `409` if one exists |
| `/change` | rotate PIN — requires the **current PIN** OR an already-unlocked session |
| `/remove` | turn the feature **off** — same authorization as `/change` |
| `/unlock` | verify PIN → open an unlock window (brute-force limited) |
| `/lock` | "Lock now" — drop this session's unlock window |
| `/heartbeat` | slide the idle window forward on activity (no-op if locked) |

Setting the first PIN is the authenticated-admin path (logged in, no PIN yet).
Change/remove require proving the current PIN OR an unlocked session (the
operator just unlocked, so they hold it — re-typing is friction). Unlock + the
current-PIN path on change/remove run through a **5-attempts / 5-min** per-session
limiter (keyed by session id, same posture as `/account/change-password`) BEFORE
the argon2id verify, so a stolen cookie can't grind PINs unbounded.

## Idle-lock UX (client side)

`web/ui/src/lib/useAdminLock.ts` + `web/ui/src/components/LockScreen.tsx`:

- On mount (when signed in) fetch lock status; a fresh load with a PIN set + no
  unlock window = locked → render `LockScreen` **instead of** the admin shell
  (one lock over everything).
- A local idle timer (the server's idle interval) flips to locked on expiry —
  promptly, instead of waiting for the next failed API call. Activity
  (pointer / key / scroll) re-arms it and debounces a `/heartbeat` that slides
  the server window forward. Re-check on tab refocus.
- **"Lock now"** button in the nav (shown only when a PIN is configured).
- The lock screen is a single PIN field → Unlock. On the `423` reality the
  server enforces, the SPA also drops its cached host-admin Bearer so a clean
  re-mint (and a clean lock screen) happens rather than riding a stale token.

## Files

- `src/admin-lock.ts` — PIN hash storage, in-memory unlock state, the
  `requireUnlocked` gate, the unlock limiter.
- `src/api-admin-lock.ts` — the `/api/admin-lock*` management router.
- `src/admin-{host-admin,channel,vault-admin,module}-token.ts` — the gate
  inserted into all four mint chokepoints.
- `src/hub-server.ts` — route wiring + CSRF belt.
- `src/hub-settings.ts` — the two new KV keys.
- `web/ui/src/components/LockScreen.tsx`, `lib/useAdminLock.ts`,
  `routes/Settings.tsx` (the manage-PIN section), `App.tsx` (lock-screen render
  + "Lock now"), `lib/api.ts` (client helpers).
- Tests: `src/__tests__/admin-lock.test.ts` (server, incl. the OAuth-unaffected
  proof), `web/ui/src/components/LockScreen.test.tsx`, `web/ui/src/App.test.tsx`
  (lock integration).
