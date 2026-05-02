# Hub web UI

Vite + React + TypeScript SPA mounted at `/hub/` on the running hub. Serves
the vault management surface (Phase 1: list + create; Phase 2+ will add
mint/revoke/config).

## Mount-aware contract

The same bundle has to work two places:

- **Production / tailnet** — served by `src/hub-server.ts` at `/hub/*`.
  Vite's `base` defaults to `/hub/` (`vite.config.ts`), so asset URLs come
  out as `/hub/assets/...` and react-router's `basename` resolves to
  `/hub`.
- **Dev** (`bun run dev`) — Vite serves at `http://127.0.0.1:5174/hub/`
  with a proxy that forwards `/admin`, `/vaults`, and `/.well-known` to
  `HUB_ORIGIN` (default `http://127.0.0.1:1939`). Override the base with
  `VITE_BASE_PATH=/` if you need to dev against the origin root.

`scripts/verify-base.mjs` runs after every build and aborts if
`dist/index.html` doesn't carry the `/hub/`-prefixed asset URLs — same
regression check paraclaw#25 codified after a silent base-drift.

**Lesson: never hardcode a leading-slash URL** in `Link to=`, `fetch`,
or `<a href>`. `Link` resolves against `BASE_URL` automatically; `fetch`
calls hit the origin root regardless of mount, which is what we want for
`/.well-known/parachute.json` and `/vaults`. If you need the mounted
prefix, use `import.meta.env.BASE_URL`.

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
├── vite.config.ts          # base=/hub/ + dev proxy
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
    │   ├── VaultsList.tsx  # /vaults
    │   ├── NewVault.tsx    # /vaults/new (single-emit pvt_* banner)
    │   └── VaultDetail.tsx # /vaults/:name (Phase 2 placeholder)
    └── test/setup.ts
```

## Build + dev

```sh
cd web/ui
bun install
bun run dev          # http://127.0.0.1:5174/hub/  (proxies to :1939)
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
`/hub/*` routes with a hint to run the build — usually means the
postinstall hasn't run yet, or fired with `--ignore-scripts` (which
suppresses lifecycle hooks).

## Brand tokens

`src/styles.css` is the single source of truth for the SPA's palette,
typography, and components. The tokens (`--accent`, `--bg`, etc.) are
lifted from `src/oauth-ui.ts` and `src/admin-config-ui.ts` so the SPA
stays visually continuous with the password-login → consent flow the
operator just walked through. Don't drift them without updating both
server-rendered surfaces.
