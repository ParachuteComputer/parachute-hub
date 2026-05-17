# Hub web UI

Vite + React + TypeScript SPA. The bundle serves at two mounts on the
running hub: `/vault/*` (primary, since the hub#168 realignment) and
`/hub/*` (back-compat for `/hub/permissions` and any bookmark that
predates the rename). Vault management Phase 1 surfaces: list + create;
Phase 2+ will add mint/revoke/config.

## Mount-aware contract

Same bundle, two mounts. Asset URLs are origin-absolute
(`/vault/assets/...`) per Vite's `base` setting, which means the HTML
loads correctly regardless of which mount served it. The mount-specific
state is the react-router `basename`, detected at runtime in
`src/main.tsx`:

- `window.location.pathname` starts with `/vault` → `basename = "/vault"`
- `window.location.pathname` starts with `/hub`   → `basename = "/hub"`
- otherwise → `basename = ""` (dev / origin root)

`src/App.tsx` uses the same detection to swap route sets — under `/vault`
the SPA renders the vault list / create / detail; under `/hub` it
renders `/permissions` (cross-vault grants) and otherwise 404s.

**Production / tailnet.** `src/hub-server.ts` mounts the SPA at both
prefixes. `/hub/vaults*` is intercepted earlier and 301-redirected to
`/vault*`. `/vault/<name>/*` first tries the dynamic vault proxy
(longest-mount-prefix off `services.json`); only single-segment SPA
routes (`/vault`, `/vault/new`, `/vault/<name>`) and `/vault/assets/*`
fall through to the SPA shell when no vault matches. Multi-segment
`/vault/<unknown>/*` requests 404 instead of being masked by HTML.

**Dev** (`bun run dev`). Vite serves at `http://127.0.0.1:5174/vault/`
with a proxy that forwards `/admin`, `/vaults`, and `/.well-known` to
`HUB_ORIGIN` (default `http://127.0.0.1:1939`). Override the base with
`VITE_BASE_PATH=/` if you need to dev against the origin root.

`scripts/verify-base.mjs` runs after every build and aborts if
`dist/index.html` doesn't carry the `/vault/`-prefixed asset URLs — same
regression check paraclaw#25 codified after a silent base-drift.

**Lesson: never hardcode a leading-slash URL** in `Link to=`, `fetch`,
or `<a href>` for in-SPA navigation. `Link` resolves against the active
basename automatically; `fetch` calls hit the origin root regardless of
mount, which is what we want for `/.well-known/parachute.json` and
`/vaults`. If you need the mounted prefix, use
`import.meta.env.BASE_URL`. Cross-mount nav (e.g. `/vault` → `/hub/permissions`)
must use `<a href>`, since `<Link>` resolves against the active basename
and would mangle the absolute path.

## Auth

The SPA leans on the hub's existing `parachute_hub_session` cookie
instead of running its own OAuth dance. `src/lib/auth.ts:getHostAdminToken()`
hits `GET /admin/host-admin-token`, which trades the session cookie for
a short-lived JWT carrying `parachute:host:admin`.

That scope is in `NON_REQUESTABLE_SCOPES` server-side, so the public
`/oauth/authorize` flow refuses to mint it — only the session-cookie
path can. See `src/scope-explanations.ts` for why and how to extend the
list.

The cached JWT lives in module-scoped state — never `localStorage`. Page
snapshots can't carry it past a refresh, and the XSS surface is the
narrowest possible.

## Layout

```
web/ui/
├── index.html              # vite entry, mounts #root
├── package.json            # @openparachute/hub-web-ui
├── vite.config.ts          # base=/vault/ + dev proxy
├── vitest.config.ts        # jsdom + setup file
├── tsconfig.json
├── scripts/verify-base.mjs # post-build regression check
└── src/
    ├── main.tsx            # BrowserRouter w/ mount-aware basename
    ├── App.tsx             # nav + Routes
    ├── styles.css          # brand tokens (kept in sync with oauth-ui.ts)
    ├── lib/
    │   ├── auth.ts         # session→JWT mint, in-memory cache
    │   └── api.ts          # listVaults + createVault
    ├── routes/
    │   ├── VaultsList.tsx  # / (under /vault basename)
    │   ├── NewVault.tsx    # /new (single-emit pvt_* banner)
    │   └── VaultDetail.tsx # /:name (Phase 2 placeholder)
    └── test/setup.ts
```

## Build + dev

```sh
cd web/ui
bun install
bun run dev          # http://127.0.0.1:5174/vault/  (proxies to :1939)
bun run build        # → dist/  (then verify-base.mjs)
bun run typecheck    # tsc --noEmit
bun run test         # vitest run
```

`web/ui/dist/` is gitignored — the hub serves it from a co-located bundle
that Vite produces. The root `package.json` wires this for you: a
`postinstall` hook runs `bun run build:spa` after every `bun install` in
the repo root, and `prepack` rebuilds before `bun pack` / `bun publish`
so the npm tarball always ships a fresh `web/ui/dist/`. The `files`
array in the root `package.json` includes `web/ui/dist`, so consumers
of the published `@openparachute/hub` package get the bundle even
though they don't get the SPA source.

If you ever need to manually rebuild, `cd web/ui && bun run build` still
works. `src/hub-server.ts` handles a missing `dist/` by 503ing the
`/vault/*` and `/hub/*` SPA routes with a hint to run the build —
usually means the postinstall hasn't run yet, or fired with
`--ignore-scripts` (which suppresses lifecycle hooks).

## Pagination convention

Paginated admin surfaces use a "Load more" cursor button (not infinite
scroll). Canonical pattern is in `src/routes/Tokens.tsx`'s `loadMore`:

```tsx
const [loadingMore, setLoadingMore] = useState(false);

async function loadMore() {
  if (loadingMore) return;            // 3. early return — fast-finger keyboard
  setLoadingMore(true);
  try {
    const page = await listX({ cursor });
    setList((prev) => ({ ...prev, items: [...prev.items, ...page.items], cursor: page.next_cursor }));
  } finally {
    setLoadingMore(false);
  }
}

<button disabled={loadingMore} onClick={() => void loadMore()}>
  {loadingMore ? "Loading…" : "Load more"}
</button>
```

Three ingredients: (1) `loadingMore` boolean, (2) `disabled={loadingMore}`
on the button (the primary defense), (3) `if (loadingMore) return` inside
the handler (belt-and-suspenders for keyboard activation, since `disabled`
only blocks pointer events).

Why all three: a double-click during a slow fetch closes over the same
list state in both invocations; the second `setState` wins and overwrites
the first's appended page. Operator sees a partial list until refresh, no
error surfaces. Caught in the hub#228 Tokens.tsx review; pinned by F1
test in `Tokens.test.tsx`.

Today's only paginated surface is `/admin/tokens`. When `/admin/permissions`
or a future view gains pagination, mirror this shape; if a third paginated
view lands, lift to a `useLoadMore` hook (hub#229's deferred option B).

## Brand tokens

`src/styles.css` is the single source of truth for the SPA's palette,
typography, and components. The tokens (`--accent`, `--bg`, etc.) are
lifted from `src/oauth-ui.ts` and `src/admin-login-ui.ts` so the SPA
stays visually continuous with the password-login → consent flow the
operator just walked through. Don't drift them without updating both
server-rendered surfaces.
