# Parachute UI / UX Audit — Hub + Services

**Date:** 2026-05-25
**Author:** Uni (research pass; Aaron steers from here)
**Scope:** committed-core (hub, vault, app, scribe) + support repos (patterns, public site)
**Status:** exploratory. Inputs to a direction conversation, not a plan.

---

## TL;DR

1. **There is no single "Parachute UI." There are eight.** Hub-discovery, hub-OAuth, hub-login, hub-account, hub-setup-wizard, hub-admin-SPA, vault-admin-SPA, vault-OAuth (standalone), app-admin-SPA, scribe-admin, Notes-PWA. They share two-and-a-half palettes and three different brand marks. The biggest single lever is **declaring a design system + a brand mark and enforcing it across every server-rendered HTML surface in one PR**.
2. **The mental model is "hub is a portal that proxies modules" — but the UX expresses "hub is admin, modules are content," with admin scattered across both.** Hub-discovery's Get-started/Services/Admin three-section split is the closest thing to a north star. Everything else fights it.
3. **The OAuth flow has two unrelated "approve" surfaces and a documented dead-end.** Inline at `/oauth/authorize` resumes the flow; SPA at `/admin/approve-client/<id>` ends with "you may now return to your app." Aaron has a fix in flight for the resume case but the underlying duplication is still there.
4. **The vault SPA dead-ends on its single forward link.** `VaultDetail.tsx` line 226 generates `${issuer}/hub/permissions?vault=<name>`. The canonical is `/admin/permissions`. The comment even acknowledges "clicks 404 until hub catches up" — hub caught up months ago at a different path.
5. **`module.json` already has the field that would fix half of this** (`uiUrl`). Vault and scribe simply don't declare one. The hub home page works around this with a hardcoded "Browse Vault" tile pointing at `/vault/<first>/admin/`. The right shape is documented; the modules just haven't adopted it.
6. **The CLI's mental model (services as flat list + verbs) and the web UI's mental model (Get started / Services / Admin / Modules / Vaults / Users / Permissions / Tokens / Settings) describe the same nouns with different vocabulary.** `parachute status` says "PROCESS / HEALTH / SOURCE"; the SPA says "Status / Active / Pending-OAuth / Disabled."

---

## 1. Surface inventory

Every user-facing surface I found, classified by who's looking at it, what auth they're carrying, and what shape it renders in. Routes are relative to the hub's public origin unless otherwise noted.

| # | Surface | Audience | Auth | Shape | Route | Notes |
|---|---|---|---|---|---|---|
| 1 | Discovery home | operator + end-user | pre-auth (session-aware tile via cookie) | server-rendered HTML (data-driven JS for tiles) | `/`, `/hub.html` | `src/hub.ts`. 3 sections: Get-started / Services / Admin. Inline CSS, emoji favicon. |
| 2 | Sign-in (admin) | operator | pre-auth | server-rendered HTML, form-POST | `/login` | `src/admin-login-ui.ts`. `Parachute` + `admin` chip + `⌬` mark. |
| 3 | Sign-out | operator | post-auth | form-POST, redirects | `/logout` | Inline form on `/` + the SPA. |
| 4 | Change password | end-user (forced) + operator (optional) | post-auth | server-rendered HTML | `/account/change-password` | `src/account-change-password-ui.ts`. Used as force-redirect target. |
| 5 | OAuth authorize (login leg) | end-user | pre-auth → post-auth | server-rendered HTML | `/oauth/authorize?response_type=code…` | `src/oauth-ui.ts` `renderLogin`. Same look as #2 but different title and form action. |
| 6 | OAuth consent | end-user | post-auth | server-rendered HTML | `/oauth/authorize` (POST or re-GET) | Same file. Vault-picker, scope rows, "Approve / Deny." |
| 7 | OAuth "App not yet approved" (auth) | operator | post-auth | server-rendered HTML | `/oauth/authorize?...` (when client status=pending) | Inline approve form, button = **"Approve and continue"**. |
| 8 | OAuth "App not yet approved" (unauth) | bystander | pre-auth | server-rendered HTML | same | "Sign in as admin to approve" CTA + shareable deep-link. |
| 9 | OAuth unknown client | end-user | pre-auth | server-rendered HTML | `/oauth/authorize?client_id=<bad>` | Reset-connection button + DCR cache-clear JS. |
| 10 | OAuth generic error | end-user | n/a | server-rendered HTML | various | Generic chrome. |
| 11 | Setup wizard | operator (one-shot) | pre-auth → post-auth | server-rendered HTML, multi-step | `/admin/setup` | `src/setup-wizard.ts`. Step progression + meta-refresh polling. Lives outside the admin SPA mount. |
| 12 | Admin SPA — Vaults | operator | post-auth (cookie → minted Bearer) | React SPA | `/admin/vaults` | hub `web/ui/`. Brand = "Parachute Admin" + subtitle. |
| 13 | Admin SPA — Modules | operator | post-auth | React SPA | `/admin/modules` | Two sections (Installed + Install a module). |
| 14 | Admin SPA — Module config | operator | post-auth | React SPA | `/admin/modules/:short/config` | Generic form against `/.parachute/config/schema`. |
| 15 | Admin SPA — Users | operator (admin only) | post-auth | React SPA | `/admin/users` | Multi-user Phase 1. |
| 16 | Admin SPA — Permissions | operator | post-auth | React SPA | `/admin/permissions` | OAuth grants by client. |
| 17 | Admin SPA — Tokens | operator | post-auth | React SPA | `/admin/tokens` | Mint / list / revoke. |
| 18 | Admin SPA — Settings | operator | post-auth | React SPA | `/admin/settings` | Hub origin, etc. |
| 19 | Admin SPA — Approve client (dead-end) | operator | post-auth | React SPA | `/admin/approve-client/:id` | Reaches success-state with "you may now return to your app." |
| 20 | Discovery JSON | machines | public | JSON + wildcard CORS | `/.well-known/parachute.json` | Drives tile rendering on #1. |
| 21 | OAuth metadata | machines | public | JSON | `/.well-known/oauth-authorization-server`, `/.well-known/jwks.json`, `/.well-known/parachute-revocation.json` | RFC 8414. |
| **Vault** | | | | | | |
| 22 | Vault admin SPA — picker | operator (rare) | post-auth (JWT in URL fragment from hub) | React SPA | `/admin/` (standalone) | `vault/web/ui/`. Different basename detection. |
| 23 | Vault admin SPA — detail | operator | post-auth | React SPA | `/vault/<name>/admin/` (via hub proxy) | Mounted per-vault. **Today: 503 because the dist bundle isn't shipped.** |
| 24 | Vault admin SPA — tokens | operator | post-auth | React SPA | `/vault/<name>/admin/tokens` | Per-vault `pvt_*` mint/revoke. |
| 25 | Vault standalone OAuth (parallel impl) | end-user | pre-auth | server-rendered HTML | `/vault/<name>/oauth/authorize` (when vault runs without hub) | `vault/src/oauth.ts`. Entirely different palette (`#0066cc` blue), Helvetica stack, owner-token field. |
| 26 | Vault REST + MCP | machines | Bearer | JSON | `/vault/<name>/...`, `/vault/<name>/mcp` | API surface, not UI. |
| **App** | | | | | | |
| 27 | App admin SPA | operator | post-auth (paste-bearer in localStorage) | React SPA | `/app/admin/` | `parachute-app/web/admin/`. **Different palette, different typography, "Modules" / "Add UI" / "Back to hub" header.** |
| 28 | Notes PWA | end-user | post-OAuth (against hub) | React PWA (Vite, tailwindcss, Instrument Serif) | `/app/notes/` | `parachute-app/packages/notes-ui`. Brand-coherent with hub-discovery. |
| 29 | App per-UI mount (future) | end-user | varies | per-UI | `/app/<ui-mount>/` | Generic host shape; only Notes today. |
| **Scribe** | | | | | | |
| 30 | Scribe admin | operator | post-auth (hub-injected Bearer; loopback open) | server-rendered HTML (vanilla JS) | `/scribe/admin` | `parachute-scribe/src/admin-ui.ts`. Uses scribe's sage `#6A9B77` for brand mark `"S"` — and **same body palette as hub home page** (good!). |
| 31 | Scribe config JSON | machines | Bearer | JSON | `/scribe/.parachute/config[/schema]` | Drives #30 + the generic module-config form (#14). |
| **CLI** (also a UX surface) | | | | | | |
| 32 | `parachute help` / `--help` | operator | n/a | terminal | (cli) | `src/help.ts`. Notable: home page tagline says "Your personal-computing modules"; CLI describes itself as "top-level CLI for the Parachute ecosystem." |
| 33 | `parachute status` | operator | n/a | terminal table | (cli) | Columns: SERVICE / PORT / VERSION / PROCESS / PID / UPTIME / HEALTH / LATENCY / SOURCE. |
| 34 | `parachute install / start / stop / upgrade / logs / expose / migrate / auth / vault` | operator | n/a | terminal | (cli) | Each is a self-contained module per CLAUDE.md. |
| 35 | `parachute setup` | operator (one-shot) | n/a | terminal | (cli) | The CLI parallel to surface #11. |

**Gaps I noticed during inventory:**

- Hub has NO `module.json` of its own (it's the supervisor, but it still has surfaces). The patterns doc admits hub is N/A for self-registration. The implication: hub doesn't have a `uiUrl` for itself either — but the discovery page IS its UI.
- App has `uiUrl: "/app/admin/"` AND `managementUrl: "/app/admin/"` pointing to the same place — so the admin SPA appears both as a discovery tile (Services section) AND in the SPA nav's Services dropdown. Vault has `managementUrl: "/admin/"` but no `uiUrl` — opposite extreme. Scribe has neither.
- The Notes PWA is the only true *end-user* surface in the ecosystem. Everything else is an operator surface dressed up as an end-user surface (the OAuth consent flow being the obvious counter — that's a real end-user flow, and the only one besides Notes).

---

## 2. The inconsistencies + dead-ends

Categorized. Citations are `path:line` form anchored to the working tree as of 2026-05-25.

### 2.1 Dead links / broken affordances

- **Vault SPA → hub permissions link points at the wrong path.** `parachute-vault/web/ui/src/routes/VaultDetail.tsx:226` builds `${issuer}/hub/permissions?vault=<name>`. Hub's canonical is `/admin/permissions` since hub#231 (the 301 redirect at `parachute-hub/src/hub-server.ts:22` is "hub/permissions → /admin/permissions" — so the link *does* resolve, via redirect, but neither side knows that). The comment at the same file even says "clicks 404 until hub catches up" — it caught up; vault didn't update.
- **Hub home `Browse Vault` tile 503s.** `parachute-hub/src/hub.ts:507` builds `/vault/<vault-name>/admin/`. The vault admin SPA's `dist/` bundle isn't shipped in the npm tarball today; `vault/src/admin-spa.ts:97` 503s with "vault admin SPA bundle not found — run bun run build". Aaron flagged this; the fix is in flight.
- **`/admin/approve-client/:id` dead-ends.** `parachute-hub/web/ui/src/routes/ApproveClient.tsx` reaches a success state that tells the operator "you may now return to your app and retry." The OAuth flow does not resume — Claude / Notes / whoever started the flow has long since forgotten about it. Fix in flight via `/oauth/authorize?return_to=...` plumbing, but the SPA page still exists for the "share-with-another-admin" deep-link case, which keeps the duplication.

### 2.2 Two surfaces to do the same thing

- **Two "approve a client" surfaces.** `/oauth/authorize` (inline, auto-resumes) vs `/admin/approve-client/<id>` (SPA, dead-ends). Different layouts, different copy, different post-action behavior, both arrive from the same trigger (OAuth flow against a pending client).
- **Two OAuth issuer UIs.** Hub's `oauth-ui.ts` and vault's `vault/src/oauth.ts`. Vault's exists for the "vault running standalone, no hub installed" case — but Parachute's marketing and design docs treat hub-as-portal as the canonical posture (`design/2026-04-20-hub-as-portal-oauth-and-service-catalog.md`). Visual languages have nothing in common; running vault standalone looks like a totally different product.
- **Two SPAs that say "admin."** `/admin/*` (hub-owned, brand = "Parachute Admin") and `/app/admin/*` (app-owned, brand = "parachute-app · admin"). Both are operator surfaces. Both manage modules-of-a-sort (hub manages backend modules; app manages hosted UI modules). The naming collision is the surface manifestation of a deeper architectural choice that's never been named: should "modules I install" and "UIs that get bundled into the app" live in the same place?
- **Two "Services" lists.** Discovery (`/`) Services section reads `uiUrl` from well-known. Admin SPA's nav has a "Services" dropdown (`web/ui/src/App.tsx:207`) reading `management_url` from `/api/modules`. Both are entry points to "open the module's UI." Different label sources, different visual treatment, different population logic.

### 2.3 Inconsistent terminology

- **Brand placement.**
  - Hub home page: `<h1>Parachute</h1>` + emoji `🪂` favicon.
  - OAuth pages: `⌬ Parachute` brand-line.
  - Admin SPA: `Parachute Admin` brand-line with subtitle reflecting the route.
  - Vault admin SPA: `Parachute Vault · admin`.
  - App admin SPA: `parachute-app · admin` (lowercase-hyphenated, looks like a package name).
  - Scribe admin: `S Scribe · configuration`.
  - Public site (parachute.computer): bespoke SVG mark, headline `Your AI has memory.`
  - Hub home tagline: `Your personal-computing modules.`
  - The thing has at least three brand-marks (`🪂`, `⌬`, bespoke SVG) and two competing top-of-funnel taglines.
- **Action verbs across the OAuth flow.** "Approve" (consent), "Approve and continue" (inline approval form), "Deny" (consent), "Sign in" (login), "Sign in as admin to approve" (unauth approval CTA), "Sign out", `<title>` strings sometimes "Authorize <client>" and sometimes "App not yet approved." Authorize / Approve / Allow / Grant are used interchangeably in copy.
- **Scope display.** Operator-facing copy uses raw scope strings (`vault:default:read`) with explainer text below; the consent screen also shows `vault:<TBD>:read` placeholders, `vault:*:read` wildcards, and admin badges. These are technically correct but read like config — an end-user consenting to Notes does not parse "verb:resource:action."
- **State words.** Module supervisor state: `active`, `pending-oauth`, `disabled`. CLI status: `running`, `stopped`, `-`. Token registry: `created_via: oauth | operator | cli`. Three vocabularies for adjacent concepts.

### 2.4 Visual / palette drift

- **Hub home page** uses `--accent: #4a7c59` (sage green) + Instrument Serif + DM Sans (loaded from Google Fonts).
- **Hub OAuth + login** use the **same color palette** but system fonts (Georgia / -apple-system) and a different brand mark, because OAuth pages explicitly avoid Google Fonts for privacy reasons (`src/oauth-ui.ts:11-14`). This is principled drift, but the result is a noticeable typography shift between `/` and `/oauth/authorize`.
- **Hub admin SPA** uses the same palette + system fonts. Tries to match OAuth screens. Mostly succeeds.
- **Vault admin SPA** mirrors hub's palette per its CLAUDE.md ("Don't drift them without updating both"). Coherent.
- **Vault standalone OAuth** (`src/oauth.ts`) uses `#0066cc` blue, Helvetica, none of the brand tokens. **Looks like a different product.** It's only reachable when vault runs without hub, but that's still a documented configuration.
- **App admin SPA** uses `#1e6bb8` (different blue), 15px body font, square-cornered buttons, table-with-uppercase-headers layout. **Looks like a different product.** This is the single largest visual outlier in the ecosystem.
- **Scribe admin** uses `#6A9B77` (sage variant) for its brand mark + the same body palette as hub home. Mostly coherent.
- **Notes PWA** uses the same palette + Instrument Serif via Google Fonts. Coherent with hub home; intentionally a more rich product UI.

### 2.5 Where-am-I confusion

The path-prefix tells you where you are, but the visual chrome doesn't always:

- Click "Vaults" tile on `/` → land on `/admin/vaults`. Header changes from `Parachute · Your personal-computing modules` to `Parachute Admin · vaults`. Different layouts. The transition is unmarked.
- Inside `/admin/*`, click "Discovery" in the nav → land on `/`. Same as above but reverse.
- Click "Open Notes" tile → land on `/app/notes/` which has its own PWA chrome. Plausible (it's a real app). But the back-to-hub affordance from inside Notes is in a popover, not the chrome.
- Click "Browse Vault" tile → land on `/vault/default/admin/` which has a separate vault-admin chrome (when the bundle ships). Different SPA, different nav, no breadcrumb back to hub-discovery.
- The OAuth flow drops you on screens that have NO nav at all (deliberately — they're auth flows; the operator should not casually wander off). But on error you're stranded.

### 2.6 Loading / error / empty states

- Hub home: loading tiles say `Loading…`; errors render in red-bordered card; empty state has rich copy ("No services with a UI declared yet…").
- Hub admin SPA: every route has its own loading copy + a generic `<div className="empty">` for empty states.
- Vault admin SPA: loading is "Loading…" italicized; auth-required is a warn-banner; missing is a separate h2; error is an error-banner. Four distinct states, four distinct treatments.
- App admin SPA: `.loading` and `.empty` classes both render "padding: 2rem; text-align: center" without further branding.
- Scribe admin: loading is `<fieldset class="loading"><legend>Loading current configuration…</legend></fieldset>` (looks like a form, not a loader).
- No shared loading spinner; no shared empty-state component; no shared error-banner shape.

### 2.7 The CLI ⇄ web disjunction

`parachute status` rows look like:

```
SERVICE          PORT  VERSION  PROCESS  PID    UPTIME  HEALTH  LATENCY  SOURCE
parachute-vault  1940  0.2.4    running  12345  2h 13m  ok      2ms      bun-linked → parachute-vault @ 8aa167b
```

The `/admin/modules` SPA route shows the same row as `Vault [v0.2.4] [Active] Restart Upgrade Configure Uninstall`. Different column names for the same data:

| CLI | SPA |
|---|---|
| SERVICE | (the row title) |
| PORT | (not shown by default) |
| VERSION | inline `v0.2.4` |
| PROCESS=running | Status="Active" |
| PROCESS=stopped | Status="Disabled" |
| HEALTH=ok | (not shown distinctly) |
| SOURCE=bun-linked → ... | (not shown) |

Three of the columns the CLI considers important (port, latency, source) don't surface in the SPA at all. The SPA's "Pending-OAuth" state has no CLI equivalent. These should be one vocabulary.

---

## 3. Mental-model assessment

### What the design docs say

From `2026-04-20-hub-as-portal-oauth-and-service-catalog.md`: hub is the front door. It owns the discovery page, OAuth issuance, and the configuration portal. Other modules are OAuth clients that the hub proxies.

From the patterns doc `module-surfaces.md`: every committed-core module exposes the same five surfaces (HTTP API, admin UI, MCP, health, self-registration). The taxonomy is "uniform surface, varied content."

From `module-ui-declaration.md`: discovery is data-driven; modules declare `uiUrl` and hub renders one tile per declaration. The "Use vs Admin" cut was retired in favor of "ownership."

### What the UX actually expresses today

Three different mental models, in tension:

1. **Hub-as-portal-that-proxies.** The home page expresses this cleanly — Get-started + Services (module-owned) + Admin (hub-owned). The discovery JSON pattern (modules declare what to surface) matches. **The most coherent surface in the system.**

2. **Hub-as-dashboard-with-everything-inside.** The `/admin/*` SPA expresses this — vaults, modules, users, permissions, tokens, settings, services dropdown all in one nav. This is the Umbrel/CasaOS shape. It pulls toward hub-as-superapp.

3. **Each module is its own product.** App's admin SPA expresses this loudest (separate palette, separate framing, "Back to hub" link). Vault's admin SPA does too (separate basename, separate brand-line). Scribe's admin does to a milder degree. This pulls toward decentralized apps that happen to share a host.

These three pull in different directions. The Get-started section's "Browse Vault" tile goes to model #3 (vault's own SPA); the Admin section's "Vaults" tile goes to model #2 (hub's vault management). Both make sense; they coexist because the underlying choice was never made explicit.

### Which framing is *right* for Parachute?

Argument for **#1 (hub-as-portal)**: matches the design docs, matches the patterns doc, the home page already expresses it, and it's the only framing that scales when third-party modules ship. Hub doesn't own the per-module UI — it's a front desk, a directory, an OAuth issuer.

Argument for **#2 (hub-as-dashboard)**: it's what most users will viscerally expect from a single-host self-hosted system (Umbrel, CasaOS). The operator wants one place to manage everything; bouncing between SPAs feels like the system is "broken into pieces."

Argument for **#3 (each module is its own product)**: this is what Notes already is (a beautiful, branded PWA at `/app/notes/`). Vault and scribe and the host module SHOULD aspire to that polish. Hub provides the seamless OAuth + discovery glue; the modules themselves are what users come back for.

**My read:** the right unified model is **#1 with strong #2-like coherence in the admin layer**. Hub-as-portal is the architecture. The expressed UX should be: "I land on Parachute. I see what's installed. I click into a module — and the module's surface feels like part of Parachute, not like a different product." That means: aggressive brand cohesion in chrome (nav, header, footer, color, type), per-module freedom in content. App's admin SPA's `#1e6bb8` blue is the canonical violation.

The Notes PWA is the proof this can work: it's its own application, it looks distinctively Notes, but it reads as Parachute because the palette, typography, and brand-mark are continuous with hub-discovery.

---

## 4. Peer-project findings

### Umbrel (the most directly analogous shape)

Single-host, owner-operated, app-store-of-self-hosted-apps. Their UI is iOS-shaped — a wallpapered home grid of installed apps, a fixed bottom dock (Home / App Store / Settings / Activity / Widgets), each app opens in a new tab. The dashboard itself is widget-driven (storage, memory, temperature). [Sources below.]

What's worth borrowing:
- **The fixed bottom dock as the cross-surface affordance.** No matter which app you're in, the dock is there. Parachute's equivalent would be a fixed top header (or bottom strip) carrying brand + "Home / Modules / Sign in/out" that's literally injected by hub into every module's chrome. The patterns doc has the seed for this (modules expose `uiUrl`; hub could inject a small navbar above each).
- **Apps open in a new tab.** Umbrel doesn't try to embed apps inside its shell. Parachute already does this — Notes is at `/app/notes/`, Vault admin is at `/vault/<name>/admin/`. The contradiction is that hub's `/admin/*` *is* an embedded shell. So hub-admin breaks the convention.
- **The dashboard widget pattern.** Each module could expose a "widget" (live stats) for the home page rather than a static tile. Vault could expose "X notes, Y tags." Scribe could expose "N transcriptions today." This makes the home page feel alive without making it a generic "dashboard."

What to avoid:
- Umbrel's heavy iOS-isms (wallpaper, dock animations) — Parachute's brand language is more typographic / serif-leaning. Don't borrow the surface, borrow the structural choice.

### Supabase (multi-service single-product)

Sidebar-driven. Each service (database, auth, storage, functions, edge functions, realtime) is a sibling in one persistent left sidebar. Recent change: organization-vs-project sidebars are separate, user-account dropdown is always top-right, and `Cmd+K` is global. [Sources below.]

What's worth borrowing:
- **The persistent left sidebar with module-as-sibling navigation.** Parachute's admin SPA has a top-nav today; a left-sidebar would scale better when modules grow (we have 9 admin sections already; a top-nav is at its limit).
- **`Cmd+K` global palette.** Hub-admin has no global search. A "go to vault X / approve client Y / mint token" command palette would be a very high-leverage add.
- **Top-right user-account dropdown.** Current placement (in the nav bar, between brand and link group) is awkward — when you sign in, the "Signed in as <name>" line crowds the nav links. Standardizing on top-right is the convention.

What to avoid:
- Supabase's density. Parachute is single-tenant + owner-operated; the high-density patterns Supabase needs for cross-org management would be over-engineered.

### Linear / Notion (general clarity language)

Both share: a quiet sans-serif body, a serif accent for headings, generous whitespace, and a single accent color used sparingly. Parachute's home page already echoes this (Instrument Serif + DM Sans + a single sage green accent). The principle: **typography carries the brand more than chrome does.** Don't over-decorate; let the type system do the work.

What's worth borrowing:
- **Lean into the typography Parachute already chose.** The brand IS Instrument Serif + DM Sans + sage. Replicate this everywhere; treat the app-admin's `#1e6bb8` + sans-stack as the bug.
- **Reduce vocabulary.** Linear has ~15 distinct action verbs across its entire product. Parachute's OAuth flow alone has 6 (Approve / Authorize / Allow / Sign in / Sign out / Deny).

### CasaOS / YunoHost / Coolify

Less specifically informative than the above. Common pattern: persistent sidebar, big app tiles on the home, every app has its own UI but is reached through a central dashboard. Parachute is already aligned on structure; the gap is execution polish.

### What patterns recur across the best of these

1. **Persistent chrome that says where you are.** Sidebar (Supabase) or dock (Umbrel) or top bar (Coolify). Parachute has top-nav inside the admin SPA but nothing persistent outside it.
2. **Apps open in new tabs / new contexts, not embedded.** All four respect this except for very small admin tasks.
3. **Single accent color, single brand mark, single type system.** Linear / Notion / Supabase all pick one and don't drift. Parachute has three brand marks (`🪂`, `⌬`, bespoke SVG) and two competing taglines.
4. **Command palette / search as the cross-cutting affordance.** Supabase has it; Linear has it; Notion has it. Parachute has nothing comparable.
5. **State words shared across CLI + web.** Coolify's "deploying / healthy / failed" matches between its CLI and its web. Parachute's CLI says `running / stopped`, the SPA says `active / pending-oauth / disabled`. Should be one vocabulary.

---

## 5. Recommended next steps (menu, not plan)

Effort estimates are rough: S = days, M = 1–2 weeks, L = 1–2 months of focused work spread across PRs.

| # | Workstream | Effort | Impact | Notes |
|---|---|---|---|---|
| **A** | **Declare a Parachute design system in `parachute-patterns/`.** One brand-mark, one tagline, one palette, one type stack, one shared chrome. Codify the existing hub-home palette as canon. | S (doc) + M (adoption) | High — the lever everything else hangs on. | Most of this is already true de facto in hub + vault + notes-ui + scribe. The doc would force app-admin (the outlier) into line. |
| **B** | **Adopt the design system in app-admin (the single biggest UI outlier).** Replace `#1e6bb8` blue + JetBrains sans-stack with hub-style sage + Georgia/system stack. | S | High — kills the largest visual discontinuity. | Should land same week as A. |
| **C** | **Declare `uiUrl` in vault + scribe `module.json`.** Retire the "Browse Vault" hardcoded tile in hub.ts; let modules declare themselves. Update `module-ui-declaration.md` and ship per-module PRs. | S | Medium-high — kills hardcoding, makes discovery extensible. | Vault's `uiUrl` is the per-vault admin (`/vault/<name>/admin/`). Scribe's is `/scribe/admin`. |
| **D** | **Collapse the two "approve client" surfaces.** Make `/admin/approve-client/<id>` redirect into the OAuth resume flow when there's a parked `authorize` request; otherwise keep its dead-end purely for share-deep-link use. Document the two cases in `oauth-dcr-approval.md`. | S-M | Medium — kills a documented dead-end. | Aaron has the resume-flow fix in flight; this is the rationalization on top. |
| **E** | **Retire vault's standalone OAuth UI (or align it).** Either drop the standalone-vault posture (declare hub required), or reskin `vault/src/oauth.ts` to use the hub palette. The current state — looking like a different product on a documented configuration — is the worst of both. | M | Medium — fixes a configuration that confuses operators who do find it. | Touches the question of "is vault-without-hub still supported?" |
| **F** | **Unify state vocabulary across CLI and SPA.** Pick `active / inactive / failing` (or similar) and use everywhere. Update `parachute status`, `/admin/modules`, the well-known doc. | S | Medium — pure-discipline fix; high "feels coherent" payoff. | Worth doing as part of the patterns design system PR (A). |
| **G** | **Add persistent cross-surface chrome.** A 32px-tall top strip injected on every server-rendered + module-served surface that carries: `Parachute · Home · Sign in/out · <user>`. Modules opt in by serving from the hub-proxy path (already true). Hub middleware injects it. | M | High — the structural fix to "where am I" confusion. | Requires deciding whether to inject for the Notes PWA (it has its own chrome); probably not. |
| **H** | **`Cmd+K` command palette in hub-admin.** "Vault default / Approve client X / Mint token / Open Notes / Sign out / Restart vault." | M | Medium-high — once tasted, hard to give up. | Defer if A-G aren't done; otherwise this becomes the new front door for power users. |
| **I** | **Audit + rewrite all action-verb copy.** OAuth: Approve / Deny. Login: Sign in / Sign out. Forms: Save / Cancel / Delete. Pick a vocabulary doc; enforce in reviewer-agent. | S | Medium — small individually, large in aggregate. | Pin to patterns. |
| **J** | **First-class loading / empty / error components in the design-system doc.** Single spinner, single empty-state shape, single error-banner shape. Ship as shared CSS in `parachute-patterns` consumed by inline-CSS surfaces and the SPAs. | S-M | Medium. | Naturally falls out of A. |

If Aaron picks only three, I'd recommend **A + B + C**. A is the lighthouse, B fixes the worst offender immediately, C closes the data-driven-discovery loop the patterns doc already pointed at.

If he picks five: add **F + G**. Those are the structural moves that make Parachute feel like one product rather than four cousins.

---

## 6. Open questions

1. **Is "vault running standalone (no hub)" still a supported configuration?** It's referenced in vault's docs (`docs/cloudflare.md`-era stuff) and the standalone OAuth UI still exists. If yes, that UI needs aligning. If no, retire the surface and the issuer-fallback logic.
2. **Is hub itself a module, or is it the host?** The patterns doc says hub is N/A for self-registration. But hub has surfaces (discovery, admin, OAuth). Should hub have a `module.json` of its own (with `uiUrl: "/admin/"`)? Today the discovery page hardcodes the Admin section's three tiles — the same hardcoding `uiUrl` retired everywhere else.
3. **Are "modules I install via `parachute install vault`" and "UIs the app bundles via `notes-ui`" the same kind of thing?** The patterns docs treat them as different (app-bundle-shape.md vs module-surfaces.md). The UI doesn't make this distinction clear (both end up surfaced via hub's discovery). Is that the right call?
4. **What's the public-facing tagline?** `Your AI has memory.` (public site) vs `Your personal-computing modules.` (hub home page) vs no tagline (admin SPA). Pick one.
5. **What's the brand mark?** `🪂` emoji favicon, `⌬` typographic mark on OAuth, bespoke SVG on the public site. Pick one.
6. **Should "Browse Vault" exist as a tile?** The patterns doc explicitly says vault should NOT have a `uiUrl` because "vault content is browsed via Notes." But Aaron added the hardcoded "Browse Vault" tile in hub#342. Reconcile: either retire the tile (defer to Notes), or update the pattern doc to legitimize it.
7. **Cross-surface auth-state visibility.** Today: hub-discovery shows "Signed in as X" via cookie. Notes shows its own session badge. Vault SPA shows nothing (the JWT it consumed was in the URL fragment and is gone). App admin shows "Token configured." Should every surface show the same user identity affordance in the same place?
8. **`/admin/setup` vs `/admin/*`.** The setup wizard lives outside the SPA mount. After completion it lands the operator in the SPA. The transition is jarring (different chrome). Should setup be part of the SPA, or should the SPA's chrome match setup's chrome?

---

## 7. Gaps in this audit

- I did NOT read the vault MCP knowledge graph (`Current/Parachute`) — that's the live-state input the workspace CLAUDE.md says to start with, and from the subagent context I can't reach the parachute-vault MCP. Aaron's read of that note may surface live concerns that supersede some findings here.
- I did NOT run the live surfaces in a browser. Everything here is from code-reading. Some "dead-end" claims may already be partially mitigated by transient redirects I missed.
- I did NOT survey users (Aaron's beta cohort, his own daily-driver use). The "where-am-I confusion" claims are inferred from the architecture; the felt experience could differ.
- I did NOT look at mobile / responsive behavior beyond noting the breakpoints exist. The OAuth flow on a phone (which IS a real use case — Notes is a PWA installed to home screen) deserves its own pass.
- I did NOT explore accessibility (color contrast ratios, keyboard nav, ARIA labels) beyond noting the SPA uses `sr-only` in one place.
- I did NOT look at dark-mode coherence across surfaces. All the surfaces have dark-mode rules but I didn't verify they actually look continuous in dark.

---

## Sources (peer-project research)

- [Umbrel App Store](https://apps.umbrel.com/)
- [Umbrel — Personal home cloud](https://umbrel.com/)
- [Umbrel review (blockdyor)](https://blockdyor.com/umbrel-review/)
- [CasaOS vs YunoHost (openalternative.co)](https://openalternative.co/compare/casaos/vs/yunohost)
- [Supabase design system — UI patterns](https://supabase.com/design-system/docs/ui-patterns/introduction)
- [Supabase Studio Dashboard (DeepWiki)](https://deepwiki.com/supabase/supabase/2.1-studio-dashboard)
- [Supabase Dashboard navigation breaking change (GH discussion)](https://github.com/orgs/supabase/discussions/33670)
- [OAuth authorization interface — oauth.com](https://www.oauth.com/oauth2-servers/authorization/the-authorization-interface/)
- [Auth0 — User Consent and Third-Party Applications](https://auth0.com/docs/authorization/user-consent-and-third-party-applications)
- [Button label best practices — UX Movement](https://uxmovement.com/buttons/5-rules-for-choosing-the-right-words-on-button-labels/)
- [NN/g — UI Copy: command names and shortcuts](https://www.nngroup.com/articles/ui-copy/)
- [Sidebar UX patterns — UX Planet](https://uxplanet.org/best-ux-practices-for-designing-a-sidebar-9174ee0ecaa2)
