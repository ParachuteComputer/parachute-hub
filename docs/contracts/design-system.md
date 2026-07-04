> Moved from parachute-patterns/patterns/design-system.md (2026-07-04) — see the patterns-archive decision. This repo enforces this contract.

# Parachute design system

The canonical visual + verbal language for every Parachute surface — the lighthouse this repo points at when a downstream module asks "what does a Parachute thing look like?"

This file declares: one brand mark, one tagline, one palette, one type stack, one verb vocabulary, one state vocabulary, one component library. Every committed-core module — hub server-rendered surfaces, hub admin SPA, vault SPA, app admin + bundled UIs, scribe admin — is expected to conform. The Notes PWA and the public site inherit the same tokens but own their own composition.

This doc is the lighthouse. Downstream workstreams (B/C/F/G/I/J in the 2026-05-25 audit) reference it; they do not re-derive its decisions. Update this file when the convention itself changes — adopters follow.

## 1. Why this doc exists

The 2026-05-25 UI/UX audit ([`parachute-hub/AUDIT-UI-UX.md`](https://github.com/ParachuteComputer/parachute-hub/blob/main/AUDIT-UI-UX.md)) found Parachute shipping eight distinct surfaces with two-and-a-half palettes, three brand marks, two competing taglines, and six action verbs covering the same OAuth approval flow. The audit's headline recommendation was Workstream A: **declare a Parachute design system in `parachute-patterns/`** as the single lever every downstream UI consistency fix hangs on (audit §5, recommendations A–J).

This is that doc. It supersedes the earlier `[DRAFT]` brand stubs in [`brand/palette.md`](../brand/palette.md), [`brand/typography.md`](../brand/typography.md), and [`brand/tokens.css`](../brand/tokens.css). Those files were ports of the parachute-daily Flutter app's tokens (Forest Green `#40695B`, Fraunces/Inter); they were never adopted by any committed-core web surface. The committed-core surfaces that did ship — hub-discovery, hub-OAuth, hub-admin, vault SPA, scribe admin, the Notes PWA — converged independently on a different palette (sage `#4a7c59`) and different type stack (Instrument Serif + DM Sans). This doc canonizes what shipped, not what was drafted.

Downstream workstreams gated on this lighthouse:

- **B** — adopt the design system in app-admin (replace `#1e6bb8` blue + `15px` body type with the canonical palette + type).
- **C** — declare `uiUrl` in vault + scribe `module.json` so the discovery page uses canonical chrome instead of bespoke tiles.
- **F** — unify state vocabulary across CLI (`running` / `stopped`) and SPA (`active` / `pending-oauth` / `disabled`).
- **G** — add persistent cross-surface chrome (the 32px brand strip).
- **I** — audit + rewrite action-verb copy across OAuth + login + forms.
- **J** — first-class loading / empty / error components shared across all surfaces.

Each workstream cites Section N of this file rather than re-deriving its decisions. When a convention here is wrong, change it here first and propagate downstream via a [migration doc](../migrations/README.md).

## 2. Brand identity

### Brand mark

The canonical Parachute mark is the bespoke dotted-grid glyph currently live on [parachute.computer](https://parachute.computer). Source-of-truth file: [`parachute.computer/assets/parachute-logo.svg`](https://github.com/ParachuteComputer/parachute.computer/blob/main/assets/parachute-logo.svg). Inlined below verbatim — copy this block when a surface needs the mark.

```html
<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <g clip-path="url(#parachute-mark-clip)">
    <path d="M23.1599 14.9453C22.7429 14.9429 22.3775 15.2985 22.375 15.7204C22.3726 16.1374 22.7282 16.5028 23.1501 16.5053C23.567 16.5077 23.9325 16.1521 23.935 15.7302C23.9374 15.3108 23.5793 14.9478 23.1599 14.9453Z" fill="currentColor"/>
    <path d="M15.758 22.3758C15.3435 22.3562 14.9657 22.702 14.9461 23.1214C14.9265 23.5359 15.2723 23.9137 15.6917 23.9333C16.1063 23.9529 16.484 23.6071 16.5036 23.1877C16.5232 22.7731 16.1774 22.3954 15.758 22.3758Z" fill="currentColor"/>
    <path d="M23.1208 9.08552C23.5721 9.10024 23.9375 8.76176 23.9473 8.31291C23.9571 7.86161 23.6137 7.50351 23.1649 7.49615C22.7308 7.49124 22.3825 7.81746 22.3604 8.24668C22.3383 8.70044 22.6744 9.06835 23.1208 9.08307V9.08552Z" fill="currentColor"/>
    <path d="M8.32678 22.3598C7.87547 22.3451 7.51002 22.6836 7.50021 23.1324C7.49039 23.5837 7.83378 23.9418 8.28263 23.9492C8.73393 23.9541 9.08712 23.6058 9.08712 23.1545C9.08712 22.7032 8.75601 22.3746 8.32678 22.3598Z" fill="currentColor"/>
    <path d="M23.1502 12.8994C23.6113 12.9019 24.0135 12.4947 24.0013 12.0361C23.9914 11.5897 23.6039 11.2095 23.16 11.207C22.6989 11.2046 22.2966 11.6117 22.3089 12.0704C22.3187 12.5143 22.7062 12.897 23.1502 12.8994Z" fill="currentColor"/>
    <path d="M12.9002 23.1849C12.9198 22.7459 12.5568 22.3436 12.1079 22.3068C11.6542 22.2725 11.2299 22.6551 11.2078 23.1162C11.1882 23.5553 11.5512 23.9575 12 23.9943C12.4538 24.0287 12.8781 23.646 12.9002 23.1849Z" fill="currentColor"/>
    <path d="M19.4899 20.3568C19.9829 20.3544 20.368 19.9595 20.3582 19.464C20.3508 18.9882 19.9755 18.6129 19.4997 18.6056C19.0067 18.5982 18.6118 18.9833 18.6094 19.4763C18.6094 19.9693 18.9969 20.3593 19.4899 20.3544V20.3568Z" fill="currentColor"/>
    <path d="M0.946568 14.8555C0.483002 14.8555 0.0881117 15.243 0.0783008 15.7066C0.0684898 16.1873 0.470738 16.5994 0.951474 16.5969C1.41504 16.5969 1.80993 16.2094 1.81974 15.7458C1.82955 15.2651 1.4273 14.853 0.946568 14.8555Z" fill="currentColor"/>
    <path d="M15.6895 1.82027C16.1678 1.83989 16.5872 1.445 16.597 0.964263C16.6044 0.500696 16.2267 0.0984479 15.7631 0.0788261C15.2848 0.0592042 14.8654 0.454094 14.8556 0.93483C14.8482 1.3984 15.2259 1.80065 15.6895 1.82027Z" fill="currentColor"/>
    <path d="M0.928315 9.18321C1.44829 9.19302 1.84073 8.81285 1.84073 8.29532C1.84073 7.79742 1.47037 7.41479 0.974917 7.40253C0.454937 7.39272 0.0625 7.77289 0.0625 8.29042C0.0625 8.79078 0.432863 9.17095 0.928315 9.18321Z" fill="currentColor"/>
    <path d="M8.33104 0.0630625C7.81106 0.0458934 7.41126 0.423614 7.40636 0.938689C7.399 1.43905 7.76691 1.82658 8.25991 1.84129C8.76272 1.85601 9.15761 1.50036 9.18459 1.00982C9.21157 0.489838 8.84121 0.0777789 8.33349 0.0630625H8.33104Z" fill="currentColor"/>
    <path d="M19.483 3.67042C18.9728 3.67042 18.5362 4.1021 18.5313 4.61227C18.524 5.11999 18.9532 5.56148 19.4634 5.57374C19.9858 5.58846 20.4445 5.1347 20.4371 4.60982C20.4298 4.09965 19.9932 3.66797 19.483 3.66797V3.67042Z" fill="currentColor"/>
    <path d="M0.976227 11.102C0.456247 11.0849 -0.00486668 11.5411 3.87869e-05 12.0611C0.00494425 12.5663 0.441531 13.0029 0.946794 13.0029C1.45206 13.0029 1.8911 12.5737 1.90091 12.066C1.91072 11.5631 1.48394 11.1192 0.976227 11.102Z" fill="currentColor"/>
    <path d="M12.0584 4.16361e-05C11.5531 -0.00486383 11.1116 0.424365 11.1018 0.93208C11.0895 1.45206 11.5457 1.91072 12.0657 1.90091C12.571 1.8911 13.0051 1.45206 13.0002 0.946797C12.9978 0.441534 12.5636 0.0049471 12.0584 4.16361e-05Z" fill="currentColor"/>
    <path d="M4.65891 18.5322C4.13894 18.5077 3.67046 18.9516 3.66801 19.479C3.6631 19.9867 4.09233 20.4257 4.6025 20.438C5.11022 20.4478 5.55416 20.0259 5.57133 19.5133C5.59095 19.0081 5.16908 18.5567 4.65891 18.5322Z" fill="currentColor"/>
    <path d="M4.58641 5.65236C5.13337 5.67443 5.62637 5.21332 5.64845 4.65654C5.67052 4.10959 5.20941 3.61659 4.65264 3.59451C4.10568 3.57244 3.61268 4.03355 3.5906 4.59032C3.56853 5.13728 4.02964 5.63028 4.58641 5.65236Z" fill="currentColor"/>
    <path d="M19.5008 16.8099C20.1017 16.8 20.5726 16.3169 20.5677 15.7159C20.5628 15.115 20.087 14.6392 19.4836 14.6367C18.8803 14.6343 18.402 15.1077 18.3946 15.7086C18.3873 16.3267 18.8803 16.8197 19.5008 16.8074V16.8099Z" fill="currentColor"/>
    <path d="M15.7209 20.5694C16.3218 20.5694 16.8025 20.0985 16.8099 19.4976C16.8172 18.8967 16.3488 18.411 15.7478 18.3988C15.1298 18.384 14.6318 18.8746 14.6368 19.4927C14.6417 20.0936 15.1199 20.5694 15.7209 20.5719V20.5694Z" fill="currentColor"/>
    <path d="M9.42652 19.4702C9.41916 18.8644 8.9188 18.364 8.31298 18.3518C7.69243 18.3395 7.1651 18.8546 7.16019 19.4751C7.15529 20.0981 7.67281 20.6157 8.29581 20.6157C8.9188 20.6157 9.43388 20.0908 9.42652 19.4702Z" fill="currentColor"/>
    <path d="M19.4553 7.16016C18.8495 7.17487 18.354 7.68259 18.3516 8.28841C18.3491 8.91141 18.8666 9.42893 19.4896 9.42403C20.1126 9.41912 20.6253 8.89669 20.6154 8.27615C20.6056 7.65316 20.0734 7.14544 19.4553 7.16261V7.16016Z" fill="currentColor"/>
    <path d="M15.7219 5.79748C16.3817 5.79748 16.9115 5.26034 16.8993 4.60055C16.887 3.95793 16.3695 3.44531 15.7244 3.44531C15.0793 3.44531 14.5348 3.98246 14.5471 4.64225C14.5593 5.28732 15.0793 5.79748 15.7219 5.79748Z" fill="currentColor"/>
    <path d="M4.63052 16.9006C5.27559 16.8957 5.78821 16.3806 5.79557 15.738C5.80292 15.0782 5.27068 14.5435 4.6109 14.5509C3.94866 14.5582 3.42623 15.0978 3.44585 15.7576C3.46302 16.4002 3.9879 16.9055 4.63052 16.9006Z" fill="currentColor"/>
    <path d="M12.0637 20.6756C12.7088 20.6683 13.2533 20.1115 13.246 19.4714C13.2386 18.8263 12.6818 18.2818 12.0417 18.2891C11.3966 18.2965 10.8521 18.8533 10.8594 19.4934C10.8668 20.1385 11.4211 20.683 12.0637 20.6756Z" fill="currentColor"/>
    <path d="M19.4762 10.8594C18.8312 10.8618 18.2842 11.4137 18.2891 12.0563C18.2915 12.7014 18.8434 13.2483 19.486 13.2434C20.1311 13.241 20.6781 12.6891 20.6732 12.0465C20.6682 11.4039 20.1188 10.8569 19.4762 10.8594Z" fill="currentColor"/>
    <path d="M8.31147 5.84627C8.98106 5.83645 9.52067 5.28459 9.51576 4.61499C9.51085 3.9454 8.9639 3.40089 8.29675 3.39844C7.62716 3.39844 7.07774 3.93804 7.07038 4.60764C7.06303 5.2944 7.6247 5.85362 8.31147 5.84627Z" fill="currentColor"/>
    <path d="M4.64934 7.0706C3.96257 7.05588 3.39599 7.6102 3.39845 8.29942C3.39845 8.96902 3.94541 9.51597 4.615 9.51843C5.2846 9.52088 5.83646 8.98128 5.84382 8.31168C5.85118 7.64209 5.31648 7.08532 4.64689 7.0706H4.64934Z" fill="currentColor"/>
    <path d="M12.0484 5.91679C12.7376 5.92169 13.3312 5.34285 13.3508 4.64873C13.3704 3.94479 12.7671 3.32916 12.0607 3.32425C11.3715 3.31934 10.7779 3.89819 10.7583 4.59231C10.7387 5.29625 11.3396 5.91434 12.0484 5.91679Z" fill="currentColor"/>
    <path d="M4.58021 13.3473C5.28169 13.3743 5.90469 12.7783 5.91695 12.0695C5.92921 11.3827 5.35528 10.7818 4.66115 10.7548C3.95967 10.7278 3.33668 11.3238 3.32441 12.0327C3.31215 12.7194 3.88609 13.3203 4.58021 13.3473Z" fill="currentColor"/>
    <path d="M15.7193 14.3359C14.9687 14.3359 14.3335 14.9761 14.3359 15.7266C14.3359 16.4772 14.9761 17.1124 15.7266 17.11C16.4772 17.11 17.1124 16.4698 17.11 15.7193C17.1075 14.9687 16.4698 14.3335 15.7193 14.3359Z" fill="currentColor"/>
    <path d="M15.7407 9.73609C16.5428 9.72628 17.1756 9.0763 17.1658 8.27671C17.156 7.47712 16.506 6.84186 15.7064 6.85167C14.9068 6.86149 14.2716 7.51146 14.2814 8.31105C14.2912 9.11064 14.9411 9.7459 15.7407 9.73609Z" fill="currentColor"/>
    <path d="M8.2987 14.2813C7.50156 14.2764 6.8565 14.9165 6.85159 15.7161C6.84669 16.5133 7.48685 17.1583 8.28644 17.1632C9.08358 17.1681 9.72865 16.528 9.73355 15.7284C9.73601 14.9313 9.09584 14.2862 8.2987 14.2813Z" fill="currentColor"/>
    <path d="M8.2854 9.79467C9.12669 9.79712 9.78647 9.15696 9.79874 8.32057C9.811 7.45967 9.15857 6.79007 8.30257 6.78516C7.46128 6.78271 6.8015 7.42533 6.78923 8.25926C6.77697 9.12017 7.4294 9.78976 8.2854 9.79467Z" fill="currentColor"/>
    <path d="M15.7268 10.5156C14.8757 10.5156 14.1644 11.2343 14.184 12.0829C14.2036 12.9242 14.9075 13.6061 15.7415 13.5914C16.5803 13.5766 17.2671 12.8801 17.2622 12.0461C17.2573 11.2097 16.5631 10.5181 15.7268 10.5156Z" fill="currentColor"/>
    <path d="M12.0588 14.1836C11.2077 14.1787 10.4964 14.8998 10.516 15.7485C10.5356 16.5897 11.2371 17.2716 12.0686 17.2593C12.9074 17.2471 13.5942 16.553 13.5917 15.7166C13.5893 14.8802 12.8976 14.1885 12.0612 14.1836H12.0588Z" fill="currentColor"/>
    <path d="M12.0397 6.66802C11.1568 6.67538 10.4356 7.39894 10.4258 8.28192C10.4185 9.17717 11.1666 9.92525 12.0618 9.91789C12.9448 9.91054 13.6659 9.18698 13.6757 8.304C13.6831 7.40875 12.935 6.66066 12.0397 6.66802Z" fill="currentColor"/>
    <path d="M8.29197 13.6757C9.1725 13.6757 9.90096 12.9619 9.91813 12.074C9.9353 11.1812 9.19212 10.4282 8.29442 10.4258C7.41389 10.4258 6.68543 11.1395 6.66826 12.0274C6.65109 12.9202 7.39427 13.6732 8.29197 13.6757Z" fill="currentColor"/>
    <path d="M12.0638 10.2891C11.068 10.2842 10.2905 11.0568 10.293 12.0526C10.293 13.0288 11.0533 13.8014 12.0222 13.8137C13.0204 13.8259 13.8077 13.0631 13.8151 12.0722C13.8225 11.074 13.0548 10.294 12.0638 10.2891Z" fill="currentColor"/>
  </g>
  <defs>
    <clipPath id="parachute-mark-clip">
      <rect width="24" height="24" fill="white"/>
    </clipPath>
  </defs>
</svg>
```

> Diff from source: `fill="#010101"` swapped for `fill="currentColor"` (so the mark inherits the surrounding text color and renders correctly in dark mode); `clipPath` id renamed `clip0_756_223` → `parachute-mark-clip` (Figma export idiom replaced with a stable, collision-resistant id); `aria-hidden="true"` added on the root `<svg>` (the mark is always paired with the "Parachute" wordmark; the wordmark carries the accessible name).

### Mark usage rules

- **Default size:** 24×24px. Scales up via CSS — the SVG itself uses `viewBox` so any width/height pair preserves proportions. Recommended sizes: 16 (favicon), 24 (chrome / nav), 32 (auth surfaces), 48+ (hero / setup wizard).
- **Color:** `currentColor`. Pair with `color: var(--accent)` for accent-on-cream surfaces, `color: var(--fg)` for ink-on-cream, `color: var(--accent-hover)` for hover lift on interactive elements.
- **Always pair with the wordmark "Parachute"** on first appearance in a surface. The mark alone is permitted in nav chrome and favicons only.
- **Retire the three legacy marks.** Hub's `🪂` parachute-emoji favicon (`src/hub.ts:124`), the `⌬` typographic mark on OAuth + login (`src/oauth-ui.ts:260, 348, 515, 686, 798`, `src/admin-login-ui.ts:67`), and the scribe-admin `S` letter-mark (`parachute-scribe/src/admin-ui.ts:80`) — all replaced by the SVG above. Workstream G migrations should do this swap as part of the persistent-chrome rollout.
- **Spacing:** at least 8px breathing room between the mark and adjacent text or chrome. The dotted-grid geometry needs negative space to read.

### Wordmark

The wordmark is the word **Parachute** set in the canonical serif (Instrument Serif, see §4). No custom letterform yet — the open question is whether to commission a custom wordmark; see §10. Display rules:

- Mark on the left, wordmark on the right, baseline-aligned.
- Optional context chip after the wordmark for sub-surfaces (e.g. `admin`, `vault`, `setup`). Chip is `0.7rem` uppercase, `letter-spacing: 0.06em`, muted color, `999px` radius, 1px border — the shape currently used on `/login` (`admin-login-ui.ts:164–172`).
- Do not lowercase + hyphenate the wordmark (`parachute-surface · admin` — the app-admin SPA's current header — is the canonical violation. It reads as a package name, not a product. Workstream B replaces it with `Parachute · app`).

### Tagline

> **Truly personal computing. Your knowledge belongs with you.**

Two short clauses. The first declares the stance ("personal" with the weight it deserves, distinct from cloud SaaS framed as personal); the second names what makes the computing personal — ownership of knowledge, framed as belonging rather than possession. Replaces the previously-shipped `Your AI has memory.` (public site) and `Your personal-computing modules.` (hub-discovery).

**Compact form**, when the full tagline doesn't fit (32px brand strip, nav bars, favicons paired with title tags): **Truly personal computing.** The second clause carries load-bearing meaning, so prefer the full form everywhere the layout allows.

The tagline is open to future refinement with the branding team (see §10), but it's now the in-use canon — adopt as-is in every surface that previously carried one of the retired lines.

### What to retire

| Surface | Current | Action |
|---|---|---|
| `parachute-hub/src/hub.ts:124` favicon | `🪂` emoji-in-SVG | Swap to the inlined mark. Workstream G. |
| `parachute-hub/src/oauth-ui.ts` brand-line (lines 260, 348, 515, 686, 798 — same shape, five surfaces) | `⌬ Parachute` | Swap to mark + wordmark. Workstream G. |
| `parachute-hub/src/admin-login-ui.ts:67–69` brand-line | `⌬ Parachute admin` (across `brand-mark` + `brand-name` + `brand-tag` spans) | Swap to mark + wordmark + `admin` chip. Workstream G. |
| `parachute-hub/web/ui/src/App.tsx` brand-line | `Parachute Admin` (with route-derived subtitle) | Swap to mark + wordmark + `admin` chip. Workstream G. |
| `parachute-surface/web/admin/` brand-line | `parachute-surface · admin` | Swap to mark + wordmark + `app` chip. Workstream B. |
| `parachute-scribe/src/admin-ui.ts` brand-line | `S Scribe · configuration` | Swap to mark + wordmark + `scribe` chip. Workstream G. |
| `parachute.computer` (public site) | bespoke SVG (canonical) | Keep — this IS the source-of-truth. |
| Notes PWA | own mark + chrome | Keep — Notes is a destination, not chrome (see §8). |

## 3. Palette

The canonical palette is the warm-cream + sage-accent stack used by hub-discovery, hub-OAuth, hub-admin SPA, vault SPA, scribe admin, and the Notes PWA. Every committed-core web surface MUST use these tokens; bespoke per-surface palettes are the canonical violation.

Source-of-truth files (all in lockstep — drift in one is a bug):

- `parachute-hub/src/hub.ts:128–157` — discovery page palette (defines the inline `<style>` for `/` and `/hub.html`)
- `parachute-hub/src/oauth-ui.ts:27–41` — OAuth surfaces palette (`PALETTE` const)
- `parachute-hub/src/admin-login-ui.ts:20–36` — login + admin error palette (`PALETTE` const)
- `parachute-hub/web/ui/src/styles.css:7–29` — admin SPA palette (`:root`)
- `parachute-vault/web/ui/src/styles.css` — vault SPA palette (mirrors hub admin SPA per its CLAUDE.md "Don't drift them without updating both")
- `parachute-scribe/src/admin-ui.ts` — scribe admin (uses the same body palette; sage variant `#6A9B77` on the scribe brand letter, retiring in Workstream G)

### Canonical tokens (light mode)

| CSS var | Value | Use |
|---|---|---|
| `--bg` | `#faf8f4` | page background — warm cream, not clinical white |
| `--bg-soft` | `#f3f0ea` | hover lifts, code backgrounds, soft surface variants |
| `--fg` | `#2c2a26` | primary text — warm near-black, not pure black |
| `--fg-muted` | `#6b6860` | secondary text, labels, subtitles |
| `--fg-dim` | `#9a9690` | tertiary text, captions, dates, meta |
| `--accent` | `#4a7c59` | sage — primary actions, links, brand-mark color, focus ring |
| `--accent-hover` | `#3d6849` | accent hover state (also reused as `--success`) |
| `--accent-soft` | `rgba(74, 124, 89, 0.08)` | accent backgrounds, tag fills, active states |
| `--accent-light` | `#6a9b77` | hover lift on card borders. Currently declared only in `parachute-hub/src/hub.ts:138` (the inline-style hub-discovery surface); this spec lifts it into the canonical token set. Surfaces that will need it added to their `:root` block when adopting: `parachute-hub/web/ui/src/styles.css`, `parachute-hub/src/oauth-ui.ts` `PALETTE`, `parachute-hub/src/admin-login-ui.ts`. |
| `--border` | `#e4e0d8` | default border on cards, inputs, dividers |
| `--border-light` | `#ece9e2` | subtler dividers (sub-unit rules in module rows, etc.) |
| `--card-bg` | `#ffffff` | card / surface fill on cream pages |
| `--error` | `#a3392b` | error border + text on banners |
| `--error-soft` | `rgba(163, 57, 43, 0.08)` | error banner fill |
| `--warn` | `#b08023` | warning border + text |
| `--warn-soft` | `rgba(176, 128, 35, 0.08)` | warning banner fill |
| `--success` | `#3d6849` | success border + text (= `--accent-hover`) |
| `--success-soft` | `rgba(61, 104, 73, 0.08)` | success banner fill |

### Canonical tokens (dark mode)

Hub-discovery declares dark-mode overrides via `@media (prefers-color-scheme: dark)` (`hub.ts:144–158`); the admin SPA does the same implicitly via per-component rules. Tokens that change:

| CSS var | Light | Dark |
|---|---|---|
| `--bg` | `#faf8f4` | `#1a1917` |
| `--bg-soft` | `#f3f0ea` | `#24221f` |
| `--fg` | `#2c2a26` | `#e8e4dc` |
| `--fg-muted` | `#6b6860` | `#a8a49a` |
| `--fg-dim` | `#9a9690` | `#6b6860` |
| `--accent` | `#4a7c59` | `#7ab08a` |
| `--accent-hover` | `#3d6849` | `#8fc49e` |
| `--accent-light` | `#6a9b77` | `#8fc49e` |
| `--border` | `#e4e0d8` | `#3a3733` |
| `--card-bg` | `#ffffff` | `#24221f` |

Semantic tokens (`--error`, `--warn`, `--success`) keep the same hex values in dark mode; the `*-soft` `rgba()` overlays auto-adjust because they're alpha against the dark background. Dark-mode coherence across all surfaces remains an open question (§10).

### Google Fonts split

OAuth + login + admin-error surfaces deliberately do NOT load fonts from Google. The reason is captured in `parachute-hub/src/oauth-ui.ts:9–14`:

> OAuth screens see who's logging in and what they're authorizing; loading fonts from Google would leak that to a third party.

This is a principled drift, not a bug. The result is:

| Surface | Font source | Why |
|---|---|---|
| Hub discovery (`/`, `/hub.html`) | Google Fonts (Instrument Serif + DM Sans) | Pre-auth tile page. No PII in the URL. Brand-forward serif headings carry the most visual weight here. |
| Hub OAuth (`/oauth/*`) | System fonts (Georgia / -apple-system) | Auth surface. Leaks would expose client_id + scope. Inline CSS only, no remote fetches. |
| Hub login (`/login`) + admin error | System fonts (Georgia / -apple-system) | Auth surface. Same posture as OAuth. |
| Hub admin SPA (`/admin/*`) | System fonts (Georgia / -apple-system) | Inherits the auth-flow posture so the SPA looks visually continuous with the password-login → consent flow the operator just walked through (per `styles.css:1–6`). |
| Vault admin SPA | System fonts (Georgia / -apple-system) | Same posture as hub admin SPA — visual continuity with auth flow. |
| App admin SPA + bundled UIs | TBD per UI | Defaults to system fonts for admin chrome; bundled UIs (Notes) may load fonts as needed for their own content. |
| Scribe admin (`/scribe/admin`) | System fonts | Loopback-only surface for now; system fonts keep boot fast. |
| Notes PWA | Google Fonts (Instrument Serif) | Destination app. Notes runs against the user's own vault — no third-party leak concern in the auth-surface sense; Notes' brand language calls for the serif. |
| Public site (`parachute.computer`) | Google Fonts | Pre-auth marketing surface. |

**Operational rule:** if a new surface is **pre-auth and brand-forward** OR **destination-app where the user's data is the user's own**, Google Fonts is allowed. Otherwise (any post-auth admin chrome, any flow showing client identity, any cross-tenant management surface) — system fonts only. When in doubt, system fonts.

§4 specifies the actual stack for each posture.

## 4. Typography

Two type stacks: a **brand-forward stack** for surfaces that may load Google Fonts (§3), and a **privacy-safe stack** for surfaces that may not. Both are designed to read continuously — the swap should feel like a different weight class, not a different product.

### Brand-forward stack (hub discovery, Notes PWA, public site)

```css
--serif: 'Instrument Serif', Georgia, serif;
--sans:  'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif;
--mono:  ui-monospace, 'SF Mono', Monaco, monospace;
```

Source: `parachute-hub/src/hub.ts:141–142` (sans + serif), `:302` (mono). The fonts load via `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=DM+Sans:wght@400;500;600&display=swap" />` (`hub.ts:127`) with `<link rel="preconnect">` priming on `fonts.googleapis.com` and `fonts.gstatic.com` (`hub.ts:125–126`).

- **Headings, brand wordmark, hero copy:** Instrument Serif. Weight 400 (the only weight Parachute ships); leverage italic variant for emphasis. Letter-spacing `-0.01em` on display sizes (per `hub.ts:228`); slight tightening keeps the serif tightly-set rather than baroque.
- **Body, UI, labels, captions, buttons:** DM Sans. Weights in use: 400 (body), 500 (labels, button text), 600 (chip text, brand-name when set in sans).
- **Code, inline mono, key/value:** system monospace stack. Never set as a Google Font — privacy-safe even on brand-forward surfaces.

### Privacy-safe stack (OAuth, login, admin SPAs, scribe admin)

```css
--font-serif: Georgia, "Times New Roman", serif;
--font-sans:  -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
--font-mono:  ui-monospace, "SF Mono", Menlo, Monaco, "Cascadia Mono", monospace;
```

Source: `parachute-hub/src/oauth-ui.ts:43–45`, `parachute-hub/src/admin-login-ui.ts:38–40`, `parachute-hub/web/ui/src/styles.css:25–27`.

- **Headings, brand wordmark on auth surfaces:** Georgia. Georgia is the closest system fallback to Instrument Serif's vibe; both are humanist serifs with relatively open counters that hold up at small sizes. Use weight 400 on headings; the system fallback is `Times New Roman` (also weight 400), which is acceptable on the rare machine without Georgia.
- **Body, UI, buttons:** the system-UI sans cascade. On Apple platforms this resolves to San Francisco; on Windows to Segoe UI; on Linux to whatever `system-ui` maps to (usually Cantarell or Noto Sans). This is intentional — we let the OS pick its native sans so the surface feels native rather than web-y on each platform.
- **Code:** same mono stack as brand-forward. `ui-monospace` resolves to SF Mono on Apple, Cascadia Mono on Windows, DejaVu Sans Mono on Linux.

### Size scale

The hub-discovery page and the SPA both use unprefixed `rem` units anchored to the browser default (`16px`). The size hierarchy in use today:

| Use | Size | Notes |
|---|---|---|
| Hero headline | `clamp(2.75rem, 6vw, 4rem)` | Serif. `hub.ts:225`. |
| Card title (discovery) | `1.4rem` | Serif. `hub.ts:281`. |
| Section heading | `1.5rem` / `1.4rem` | Serif on discovery, sans on SPA. |
| H2 (SPA) | `1.4rem`, weight 500 | Sans. `styles.css:243–246`. |
| H1 (login + auth cards) | `1.75rem` | Serif. `admin-login-ui.ts:173–180`. |
| Body | `1rem` (= 16px) | Sans, line-height 1.5. |
| Muted / subtitle | `0.92–0.95rem` | Sans, color `--fg-muted`. |
| Caption / dim | `0.78–0.85rem` | Sans, color `--fg-dim`. |
| Button label | inherits (= 1rem) | Sans, weight 500. |
| Chip / tag | `0.7rem` uppercase, `letter-spacing: 0.06em` | Sans. |
| Code | `0.85em` | Mono. Cascades from parent size, not anchored to root. |

Don't introduce new sizes ad-hoc. If a surface needs a size not in this scale, propose adding it here first.

### Things to avoid

- **`#1e6bb8` blue + 15px body size + square-cornered buttons on app-admin** (`parachute-surface/web/admin/src/styles.css:16` body size, `:21` accent text, `:121, :123` button fill + border, `:275` accent text). The font stack on app-admin is system-UI (`-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif` at `:12`) — same family as the privacy-safe stack — so the typographic outlier is the *size scale*, not the font family. Workstream B brings the palette + size + radii into conformance.
- **Cramming custom font-faces into auth surfaces.** Don't add an `@font-face` rule or Google Fonts link to any privacy-safe surface (per §3). System fonts only.
- **Using the brand serif for body copy.** Instrument Serif is for headings, hero, brand wordmark. Body is always sans.
- **Bumping serif weight above 400.** Instrument Serif ships at weight 400 only; bolding it pulls a synthetic-bold from the browser and looks broken. If a heading needs more weight, scale it up rather than bolding it.

## 5. Verb vocabulary

The 2026-05-25 audit (§2.3) found the OAuth flow alone using six interchangeable verbs (Approve / Authorize / Allow / Grant / Sign in / Deny) plus `<title>` strings that drift between "Authorize <client>" and "App not yet approved." This section pins one verb per concept across every surface. Workstream I rewrites the existing copy to match.

### Canonical verbs

| Concept | Canonical verb | Use everywhere |
|---|---|---|
| Establish a session | **Sign in** | Pre-auth → post-auth. Button text, link text, `<title>`. |
| End a session | **Sign out** | Post-auth → pre-auth. Button text, link text. |
| Grant an OAuth client the permissions it asked for | **Approve** | OAuth consent screen primary button. |
| Reject an OAuth client's request | **Deny** | OAuth consent screen secondary button. |
| Admin flags a not-yet-trusted client as trusted | **Approve** | Inline pending-client form + the SPA approve-client surface. (Same verb as consent — they are the same concept at different scope.) |
| Move forward from a non-terminal screen (wizard step, optional review) | **Continue** | Setup wizard advance, multi-step forms. |
| Persist edits to a config / settings form | **Save** | Module-config forms, hub settings. |
| Discard edits without persisting | **Cancel** | Modal close, form-row close. |
| Remove a row / revoke a token / uninstall a module | **Delete** for rows, **Revoke** for tokens, **Uninstall** for modules | Per-domain; see below. |
| Restart a running module | **Restart** | Module row action. |
| Upgrade a module to a newer published version | **Upgrade** | Module row action. |
| Open a hosted UI in the operator's browser | **Open** | Module row action when `uiUrl` declared. |

### Retired verbs

| Verb | Where it appears today | Replace with |
|---|---|---|
| **Authorize** | `<title>Authorize <client>?</title>` (`oauth-ui.ts:351`, `:376`), the `/oauth/authorize` route name | Keep the route name (it's the RFC 6749 path; not user-facing). Title becomes `Approve <client>` (page H1 already says "Approve / Deny"). |
| **Allow** | Occasional informal use in copy | **Approve** when the user is consenting; **Save** when the user is editing a permission. |
| **Grant** | "OAuth grants by client" SPA copy + `/api/grants` route | Keep `/api/grants` (data shape — RFC 6749's "grant" is the noun for what was issued). User-facing copy uses **Approve** for the verb, **approval** for the noun. |
| **Approve and continue** | Inline pending-client form button (`oauth-ui.ts:508`) | **Approve** — the "and continue" is implied (every Approve action moves forward; explicit-continue is verbose). |
| **Sign in as admin to approve** | Unauth approval CTA (`oauth-ui.ts:592`) | **Sign in to approve** — every operator on this hub is an admin in some sense; the role qualifier is redundant. |
| **Connect** | Not currently in committed-core, but tempting for OAuth flows | Don't introduce. Use **Sign in** (for auth) or **Approve** (for consent). |

### Per-domain verb tables

Three domains where the audit found the most drift. Implementers updating copy in Workstream I should diff their existing strings against these tables.

**OAuth flow (`/oauth/*`, `/login`, `/logout`):**

| Surface | Today | Canonical |
|---|---|---|
| Login form submit (`/login`, `/oauth/authorize` login leg) | `Sign in` | `Sign in` (no change) |
| Consent primary button | `Approve` | `Approve` (no change) |
| Consent secondary button | `Deny` | `Deny` (no change) |
| Pending-client inline submit | `Approve and continue` | `Approve` |
| Pending-client unauth primary CTA | `Sign in as admin to approve` | `Sign in to approve` |
| Page `<title>` on `/oauth/authorize` consent | `Authorize <client>` | `Approve <client>` |
| Page `<title>` on `/oauth/authorize` pending | `App not yet approved` | `Approve <client>?` |
| Sign-out form | `Sign out` | `Sign out` (no change) |

**Module + vault management (admin SPA, `/admin/*`):**

| Surface | Today | Canonical |
|---|---|---|
| `/admin/modules` row actions | `Restart`, `Upgrade`, `Configure`, `Uninstall` | unchanged |
| `/admin/modules` install button | `Install` | unchanged |
| Vault create form — moved to vault's own surface at `/vault/admin/` (2026-06-09 boundary shift, [`hub-module-boundary.md`](./hub-module-boundary.md)); the hub keeps the setup-wizard vault step + a zero-instances bootstrap affordance | `Create vault` | unchanged — the verb moves with the surface |
| `/admin/tokens` mint | `Mint token` | unchanged |
| `/admin/tokens` row action | `Revoke` | unchanged |
| `/admin/permissions` row action | `Revoke` (the grant) | unchanged |
| `/admin/users` row actions | `Delete`, `Demote`, `Promote` | unchanged |
| `/admin/settings` form | `Save` (+ `Reset to default`) | unchanged |
| `/admin/approve-client/<id>` primary | `Approve` (already correct) | unchanged |

The admin SPA is mostly in good shape — the rewrite work is concentrated on the OAuth flow.

**Discovery + module surfaces (`/`, hosted UI rows):**

| Surface | Today | Canonical |
|---|---|---|
| Hub-discovery tile CTA | per-tile (`Open Vault`, `Browse Vault`, `Open Notes`) | **Open** (consistent verb across all tiles). The noun follows from the tile's title. |
| Module-row hosted-UI sub-unit link | (varies) | **Open** |
| Setup-wizard step advance | (varies) | **Continue** |
| Setup-wizard final step | `Finish` (or similar) | **Continue** → on the final step swap to **Open Parachute** (the post-setup landing affordance) |

### Title strings

Page `<title>` follows the format `<Verb> <object> · Parachute` for action surfaces, `<noun> · Parachute` for management surfaces, plain `Parachute` for `/`.

Examples:

- `/login` → `Sign in · Parachute`
- `/oauth/authorize` (consent) → `Approve <client> · Parachute`
- `/oauth/authorize` (pending-client) → `Approve <client>? · Parachute`
- `/vault/admin/` (vault's multi-vault home; the hub's `/admin/vaults` route retires per [`hub-module-boundary.md`](./hub-module-boundary.md)) → `Vaults · Parachute`
- `/admin/approve-client/<id>` → `Approve <client> · Parachute`
- `/` → `Parachute`

## 6. State vocabulary

The 2026-05-25 audit (§2.7) found three different vocabularies for the same module-supervisor concept: CLI says `running` / `stopped` / `-`; admin SPA says `Active` / `Pending-OAuth` / `Disabled`; the supervisor's internal state model says `active` / `pending-oauth` / `disabled`. Adjacent concepts (health-probe result, token source) carry their own per-surface vocabularies on top of that. Workstream F unifies these.

### Canonical states (module supervisor)

Four lowercase states, in CSS class form `status-<state>`:

| State | Meaning | Replaces | Color |
|---|---|---|---|
| `active` | Module is supervised, process is running, last health probe succeeded. | CLI `running`, SPA `Active`, supervisor `active` | `--success` / `--success-soft` |
| `pending` | Module is supervised but needs operator action before it can run (OAuth not yet completed, config not yet supplied, etc.). | SPA `Pending-OAuth` (broaden — pending-config is the same concept), supervisor `pending-oauth` | `--warn` / `--warn-soft` |
| `inactive` | Module is supervised but the operator has deliberately stopped it. | CLI `stopped`, SPA `Disabled`, supervisor `disabled` | `--fg-muted` / `--bg-soft` |
| `failing` | Module is supervised, process is running OR restart-looping, last health probe failed. | CLI `running` + health `unhealthy` (currently two columns; collapse) | `--error` / `--error-soft` |

**Why four, not three.** The audit recommended `active / inactive / failing` (three). Adding `pending` preserves the OAuth-pre-approval state that the SPA's `pending-oauth` color already captures — without `pending`, the SPA loses a meaningful "not your fault, but you need to do a thing" state that's distinct from "broken" (`failing`) and from "operator deliberately stopped it" (`inactive`). The four-state vocabulary maps cleanly to the four reasonable operator reactions: ignore (`active`), do a thing (`pending`), do nothing it's intentional (`inactive`), investigate (`failing`).

### Mapping table

| Old term | Surface | New canonical | Migration note |
|---|---|---|---|
| `running` | `parachute status` PROCESS column | `active` (when healthy) / `failing` (when unhealthy) | Collapse `PROCESS` + `HEALTH` columns into one `STATE` column. |
| `stopped` | `parachute status` PROCESS column | `inactive` | Direct rename. |
| `-` | `parachute status` PROCESS column when no pidfile | `inactive` | Same surface as deliberately stopped — both mean "not running and we're not trying." |
| `Active` | SPA `/admin/modules` status badge | `active` | Lowercase. |
| `Pending-OAuth` | SPA `/admin/modules` status badge | `pending` | Broadens; CSS class becomes `status-pending`. Old `status-pending-oauth` class redirects to `status-pending`. |
| `Disabled` | SPA `/admin/modules` status badge | `inactive` | The word "disabled" overloads with HTML's button `:disabled` and is read as "broken" by some operators; `inactive` reads cleaner. |
| `ok` / `http <code>` / `down` | `parachute status` HEALTH column (per `parachute-hub/src/commands/status.ts:253–257`) | not user-facing as state — internal probe result | The user-facing rollup is `active` (healthy) / `failing` (any non-ok). `LATENCY` column survives as a separate measurement. |
| `active` | supervisor internal state | `active` | Same. |
| `pending-oauth` | supervisor internal state | `pending` | Rename. |
| `disabled` | supervisor internal state | `inactive` | Rename. |
| (new) | | `failing` | New state. Supervisor sets when health-probe failure crosses a threshold (definition is Workstream F's call — recommend "3 consecutive failures or restart-loop"). |

### CSS classes + colors

Workstream F renames the existing classes; the color tokens already exist (§3 palette). Today's `parachute-hub/web/ui/src/styles.css:807–829`:

```css
.status { background: var(--bg-soft); color: var(--fg-muted); ... }
.status-active        { background: var(--success-soft); color: var(--success); }
.status-pending-oauth { background: var(--warn-soft);    color: var(--warn); }
.status-disabled      { background: var(--bg-soft);      color: var(--fg-dim); }
```

becomes:

```css
.status { background: var(--bg-soft); color: var(--fg-muted); ... }
.status-active   { background: var(--success-soft); color: var(--success); }
.status-pending  { background: var(--warn-soft);    color: var(--warn); }
.status-inactive { background: var(--bg-soft);      color: var(--fg-dim); }
.status-failing  { background: var(--error-soft);   color: var(--error); }
/* Back-compat for one release window: */
.status-pending-oauth { background: var(--warn-soft); color: var(--warn); }
.status-disabled      { background: var(--bg-soft);   color: var(--fg-dim); }
```

The back-compat classes can retire one rc-chain after Workstream F lands.

### What stays per-domain

Some state vocabularies are domain-specific and don't roll up to the four canonical states:

- **Token source** (`oauth` / `operator` / `cli`) — provenance of a minted token. Not a supervisor state; stays as the `.tag.source-<kind>` chip in `styles.css:325–360`.
- **OAuth grant state** (`pending` / `approved` / `revoked`) — OAuth client lifecycle. `pending` collides with the new module state but the context (`/admin/permissions` row vs `/admin/modules` row) disambiguates; keep the OAuth-grant `pending` as-is.
- **Process lifecycle** (`starting` / `restarting` / `stopping`) — transient supervisor states surfaced by `parachute logs` and the SPA's restart action. Optional addition; not required by Workstream F. If added, render as muted variants of `active` (in-progress) or `inactive` (winding down).

### CLI `status` column shape

The CLI's `parachute status` columns today:

```
SERVICE  PORT  VERSION  PROCESS  PID  UPTIME  HEALTH  LATENCY  SOURCE
```

After Workstream F:

```
SERVICE  PORT  VERSION  STATE   PID  UPTIME  LATENCY  SOURCE
```

`STATE` is one of `active` / `pending` / `inactive` / `failing` and replaces the `PROCESS` + `HEALTH` columns (which encoded the same information in two columns). `LATENCY` stays alongside; it's a measurement, not a state.

## 7. Components

Shared component shapes — HTML + CSS, framework-agnostic. Server-rendered surfaces drop the HTML in directly; React/Vue surfaces wrap the same DOM. All snippets assume the `--*` tokens from §3 are in scope.

### Buttons

Three variants. Most current surfaces already get this right; the spec exists to keep new surfaces from inventing a fourth.

```css
button, .btn {
  font: inherit;
  background: var(--accent);
  color: white;
  border: 0;
  border-radius: 6px;
  padding: 0.55rem 1.1rem;
  cursor: pointer;
  transition: background 0.15s ease;
  text-decoration: none;
  display: inline-block;
}
button:hover, .btn:hover { background: var(--accent-hover); }
button:disabled, .btn:disabled { opacity: 0.5; cursor: not-allowed; }

button.secondary, .btn.secondary {
  background: white;
  color: var(--fg);
  border: 1px solid var(--border);
}
button.secondary:hover, .btn.secondary:hover { background: var(--bg-soft); }

button.destructive, .btn.destructive {
  background: white;
  color: var(--error);
  border: 1px solid var(--error);
}
button.destructive:hover, .btn.destructive:hover {
  background: var(--error-soft);
}
```

- **Primary** (default `button`): sage fill, white text. Use for the one most-likely action per form. Never more than one primary per visible area.
- **Secondary** (`button.secondary`): white fill, ink text, border. Use for adjacent actions of equal weight (Cancel beside Save), or for any action when there's already a primary nearby.
- **Destructive** (`button.destructive`): white fill, error-color text + border. Use for Delete / Revoke / Uninstall. **This is a new convention**, not a codification — today's `parachute-hub/web/ui/src/styles.css:580–588` `.module-config-form .actions button.destructive` uses `color: var(--fg)` (ink) + `border: var(--border)` (neutral); the only "destructive" affordance is the lack-of-primary-fill. The §7 spec above proposes lifting it to `color: var(--error)` + `border-color: var(--error)` so destructive actions read distinctly across surfaces. Workstream J adopts.

Source today: `parachute-hub/web/ui/src/styles.css:49–73` (primary + secondary), `:701–718` (`.btn` link variant), `:580–588` (the existing soft-destructive shape that this spec strengthens).

### Brand-line (header chrome)

The persistent mark + wordmark + optional context chip. Drop into the top-left of any surface that's not the public site (which has its own composition).

```html
<div class="brand">
  <span class="brand-mark"><!-- SVG from §2 inlined here, 24×24 --></span>
  <span class="brand-name">Parachute</span>
  <span class="brand-chip">admin</span> <!-- optional -->
</div>
```

```css
.brand {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--accent);
  font-weight: 500;
  font-size: 0.95rem;
  font-family: var(--serif, var(--font-serif));
}
.brand .brand-mark { width: 24px; height: 24px; display: inline-flex; }
.brand .brand-name {
  font-family: var(--serif, var(--font-serif));
  font-weight: 400;
  font-size: 1.15rem;
  color: var(--fg);
  letter-spacing: 0.01em;
}
.brand .brand-chip {
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 0.7rem;
  color: var(--fg-muted);
  border: 1px solid var(--border-light);
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
  font-family: var(--sans, var(--font-sans));
}
```

Source today: `parachute-hub/src/admin-login-ui.ts:153–172` (the existing brand-line CSS shape, exposing classes `.brand`, `.brand-mark`, `.brand-name`, `.brand-tag`). This spec proposes two changes: (1) retire the `⌬` glyph and substitute the SVG mark inside `.brand-mark`; (2) rename the chip class `.brand-tag` → `.brand-chip` (the word "tag" overloads with the existing `.tag` accent-chip in `styles.css:307–319`). A one-release back-compat alias keeps `.brand-tag` working in CSS while the HTML emit sites are migrated.

HTML emit sites that currently render `class="brand-tag"` (must be updated to `brand-chip` in the same migration window as the CSS alias retires, otherwise the back-compat-alias removal silently un-styles the chip): `parachute-hub/src/admin-login-ui.ts:69`, `parachute-hub/src/oauth-ui.ts` (multiple sites — grep for `brand-tag`), `parachute-scribe/src/admin-ui.ts:83`. Workstream G owns the migration sweep.

### Loading

One spinner across all surfaces. Today there are four distinct loading treatments (audit §2.6). One shape:

```html
<div class="loading" role="status" aria-live="polite">
  <span class="loading-spinner" aria-hidden="true"></span>
  <span class="loading-label">Loading…</span>
</div>
```

```css
.loading {
  display: inline-flex;
  align-items: center;
  gap: 0.6rem;
  padding: 1.25rem 1rem;
  color: var(--fg-muted);
  font-size: 0.92rem;
}
.loading-spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid var(--accent-soft);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: parachute-spin 0.7s linear infinite;
}
@keyframes parachute-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .loading-spinner { animation: none; opacity: 0.5; }
}
```

- The label is always **Loading…** (one ellipsis character, not three dots). Per-surface qualifiers ("Loading vaults…", "Loading current configuration…") are allowed but optional — the spinner is what carries the meaning.
- `role="status"` + `aria-live="polite"` so screen readers announce the loading state without preempting other speech.
- Honor `prefers-reduced-motion`.

### Empty state

Two variants. The audit's "no shared empty-state shape" finding maps to merging today's `.empty` and `.empty-rich` into one component with a `--rich` modifier.

```html
<!-- Minimal empty (use in compact lists / sidebar widgets) -->
<div class="empty">
  No vaults yet.
</div>

<!-- Rich empty (use as the route-level "nothing to show" affordance) -->
<div class="empty empty-rich">
  <p class="empty-headline">No services with a UI declared yet.</p>
  <p class="empty-body">
    Install a module with <code>parachute install &lt;short&gt;</code>;
    declared <code>uiUrl</code>s will appear here as tiles.
  </p>
</div>
```

```css
.empty {
  padding: 1.5rem 1rem;
  text-align: center;
  color: var(--fg-muted);
  background: var(--bg-soft);
  border-radius: 10px;
  font-size: 0.95rem;
}
.empty.empty-rich {
  text-align: left;
  padding: 2rem 1.75rem;
  background: var(--card-bg);
  border: 1px solid var(--border);
}
.empty .empty-headline {
  font-size: 1.05rem;
  color: var(--fg);
  margin: 0 0 0.5rem;
  font-weight: 500;
}
.empty .empty-body {
  margin: 0;
  color: var(--fg-muted);
}
.empty code {
  font-family: var(--mono, var(--font-mono));
  background: var(--bg);
  padding: 0.1em 0.4em;
  border-radius: 4px;
  color: var(--accent);
}
```

Source today: `parachute-hub/web/ui/src/styles.css:276–294` (the minimal + rich variants — this spec just merges them into one selector with a modifier).

### Banners (error / warn / success)

```html
<p class="banner banner-error">
  Something went wrong. <code>500 Internal Server Error</code>.
</p>
<p class="banner banner-warn">
  Your assigned vault has been removed. Contact your admin.
</p>
<p class="banner banner-success">
  Token created. Copy it before leaving this page — it won't be shown again.
</p>
```

```css
.banner {
  margin: 0 0 1rem;
  padding: 0.75rem 1rem;
  border-radius: 8px;
  border: 1px solid transparent;
  font-size: 0.9rem;
}
.banner-error   { background: var(--error-soft);   border-color: var(--error);   color: var(--error); }
.banner-warn    { background: var(--warn-soft);    border-color: var(--warn);    color: var(--warn); }
.banner-success { background: var(--success-soft); border-color: var(--success); color: var(--success); }
.banner code {
  font-family: var(--mono, var(--font-mono));
  font-size: 0.85em;
  background: rgba(255, 255, 255, 0.5);
  padding: 0.1em 0.3em;
  border-radius: 3px;
}
```

Source today: `parachute-hub/web/ui/src/styles.css:257–274` (`.error-banner` + `.warn-banner`) and `:590–611` (`.banner-success` + `.banner-error`). The spec unifies the two competing names (`.error-banner` vs `.banner-error`) on the `banner-<level>` form (the form already used by the module-config surfaces).

Workstream F renames the existing `.error-banner` → `.banner-error` etc. with a one-release back-compat alias.

### Status badge

The state-vocabulary chip from §6, repeated here as a component spec for completeness:

```html
<span class="status status-active">active</span>
<span class="status status-pending">pending</span>
<span class="status status-inactive">inactive</span>
<span class="status status-failing">failing</span>
```

CSS already specified in §6.

### Persistent chrome strip (Workstream G)

A 32px-tall top strip injected on every server-rendered + module-served surface that carries: `[mark + wordmark] · Home · [signed-in cluster]`. Modules opt in by serving from the hub-proxy path; hub middleware injects the strip.

```html
<header class="pc-chrome" role="banner">
  <a href="/" class="pc-chrome-brand">
    <span class="pc-chrome-mark"><!-- 16×16 SVG mark --></span>
    <span class="pc-chrome-wordmark">Parachute</span>
  </a>
  <nav class="pc-chrome-nav" aria-label="primary">
    <a href="/">Home</a>
  </nav>
  <div class="pc-chrome-auth">
    <!-- One of: signed-in cluster (<span>Signed in as <strong>X</strong></span> <button>Sign out</button>) OR <a>Sign in</a> -->
  </div>
</header>
```

**Token-fallback shim — load-bearing.** The strip is injected into surfaces that *may not have declared the canonical palette tokens at the document root* (e.g. a module SPA whose `:root` block predates this doc, or a future third-party module that doesn't yet conform). Without a fallback chain the strip renders invisible white-on-white or unstyled. The chrome's `<style>` block opens with a local-scope shim that defaults the chrome's own tokens to hex values matching the canonical palette, then references the document's `--bg-soft`/`--fg`/`--accent` etc. when present:

```css
.pc-chrome {
  /* Local shim — falls back to canonical hex when the host page
     hasn't declared the design-system tokens at :root. The chrome
     renders identically on a conforming surface (vars resolve to the
     declared tokens) or a non-conforming surface (vars resolve to
     these hex defaults). Update the hex literals in lockstep with
     §3's canonical palette if the palette ever shifts. */
  --pc-chrome-bg-soft: var(--bg-soft, #f3f0ea);
  --pc-chrome-fg: var(--fg, #2c2a26);
  --pc-chrome-fg-muted: var(--fg-muted, #6b6860);
  --pc-chrome-border: var(--border, #e4e0d8);
  --pc-chrome-accent: var(--accent, #4a7c59);

  box-sizing: border-box;
  position: sticky;
  top: 0;
  z-index: 100;
  height: 32px;
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0 1rem;
  background: var(--pc-chrome-bg-soft);
  border-bottom: 1px solid var(--pc-chrome-border);
  font-size: 0.85rem;
  font-family: var(--sans, var(--font-sans));
}
.pc-chrome *, .pc-chrome *::before, .pc-chrome *::after {
  box-sizing: border-box;
}
.pc-chrome-brand {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  color: var(--pc-chrome-fg);
  text-decoration: none;
  font-weight: 500;
}
.pc-chrome-brand .pc-chrome-wordmark {
  font-family: var(--serif, var(--font-serif));
  font-size: 0.95rem;
}
.pc-chrome-nav {
  display: inline-flex;
  gap: 0.85rem;
  margin-left: 0.5rem;
}
.pc-chrome-nav a {
  color: var(--pc-chrome-fg-muted);
  text-decoration: none;
}
.pc-chrome-nav a:hover { color: var(--pc-chrome-fg); }
.pc-chrome-auth {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  color: var(--pc-chrome-fg-muted);
}
.pc-chrome-auth strong { color: var(--pc-chrome-fg); font-weight: 600; }
.pc-chrome-auth a, .pc-chrome-auth button {
  background: none;
  border: 0;
  color: var(--pc-chrome-accent);
  padding: 0;
  cursor: pointer;
  font: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
}
```

**Where to inject:**

- All hub-owned server-rendered surfaces (`/`, `/login`, `/logout`, `/oauth/*`, `/admin/setup`, generic admin errors).
- All proxied module surfaces served under `/<short>/admin/*` and `/vault/<name>/admin/*` (hub injects via middleware on the proxy response).
- All app-bundled UI surfaces under `/surface/admin/*` (app's host injects).
- All hub admin SPA routes (the SPA renders the strip at the top of `<App>`).

**Where NOT to inject:**

- The Notes PWA at `/surface/notes/*`. Notes is a destination, not chrome — it owns its own header. (Audit §4: "the Notes PWA is the proof this can work: own application, looks distinctively Notes, reads as Parachute because the tokens are continuous.")
- The discovery JSON / well-known JSON / OAuth metadata endpoints (machine-readable, no chrome).

**Injection mechanism:** Workstream G's call. Options include a hub-middleware string-replace on `<body>` of any `text/html` proxy response, a hub-issued JS snippet that mounts a top-of-page element, or a module-side convention where each module imports a shared HTML fragment. The CSS + DOM shape above is the contract; the injection mechanism is implementation detail.

### Form actions cluster

```html
<div class="form-actions">
  <button type="submit" class="btn">Save</button>
  <button type="button" class="btn secondary">Cancel</button>
</div>
```

```css
.form-actions {
  display: flex;
  gap: 0.6rem;
  align-items: center;
  margin-top: 1rem;
}
.form-actions .btn.destructive {
  margin-left: auto;
}
```

Primary on the left, secondary beside, destructive pushed to the far right (the visual distance discourages accidental clicks). The new `.form-actions` class is a convention this spec introduces — the existing equivalent (`form .actions` descendant selector at `parachute-hub/web/ui/src/styles.css:415–420`, paired with the destructive offset at `:576–588`) is preserved as the source of the values, but the class-based form is the canonical shape going forward (descendant-selector form continues to work; adopters can rename in their next surface-touching PR).

## 8. Where this applies

Three concentric circles of conformance — strict at the center, looser at the edge.

### Circle 1 — committed-core admin chrome (strict conformance)

Every surface in this ring uses the canonical mark (§2), canonical palette (§3), privacy-safe type stack (§4), canonical verbs (§5), canonical states (§6), and shared components (§7). No exceptions, no per-module palettes.

| Module | Surfaces in scope |
|---|---|
| `parachute-hub` | `/`, `/hub.html`, `/login`, `/logout`, `/account/change-password`, `/oauth/*`, `/admin/setup`, `/admin/*` (the SPA), all generic error pages |
| `parachute-vault` | `/vault/<name>/admin/*` (the per-vault SPA mounted via hub proxy), `/vault/admin/*` (the daemon-level multi-vault home — create/delete vaults; 2026-06-09 boundary shift, [`hub-module-boundary.md`](./hub-module-boundary.md)), the standalone vault admin SPA at `/admin/` (when reachable; Workstream E is retiring the standalone OAuth surface separately — see §10) |
| `parachute-surface` | `/surface/admin/*` (the app-admin SPA — currently the largest outlier; Workstream B brings it into conformance) |
| `parachute-scribe` | `/scribe/admin` (the server-rendered admin) |

These surfaces share an operator audience and an auth posture (post-session-cookie, mostly). Visual continuity here is what makes Parachute read as "one product, several rooms" instead of "four cousins."

### Circle 2 — committed-core hosted UIs (inherit tokens, own composition)

Apps that the host module bundles inherit the palette + mark + type stack but compose their own layout, navigation, and interaction patterns. The persistent chrome strip from §7 may sit at the top of these (Workstream G's call per app), but the app's interior is its own.

| Module | Surfaces in scope |
|---|---|
| `parachute-surface` packages | `/surface/notes/*` (Notes PWA — the canonical example of inherit-tokens-own-composition), future `/surface/<ui>/*` apps as they ship |

Notes already does this well (audit §4): "own application, looks distinctively Notes, reads as Parachute because the tokens are continuous." Future apps under `parachute-surface/packages/` are expected to clear the same bar — adopt the tokens, then compose freely.

### Circle 3 — brand-mark source of truth (separate composition entirely)

The public site is the source-of-truth for the brand mark (§2). It uses the canonical palette + type but composes a marketing-site layout that doesn't share components with any committed-core surface.

| Module | Surfaces in scope |
|---|---|
| `parachute.computer` | The static site — landing, blog, design notes, install guide |

### What's NOT in scope

- **The CLI** (`parachute` binary). The CLI's vocabulary (commands, state words) is governed by §5 + §6 because cross-surface consistency matters. But it's a terminal, not a web surface — palette, typography, and component shapes don't apply.
- **Machine surfaces.** Discovery JSON (`/.well-known/parachute.json`), OAuth metadata, JWKS, MCP endpoints, REST APIs. These are read by programs, not people.
- **Third-party modules**, when they exist. They may adopt the design system (and the docs above are written so they can). They aren't required to — the goal here is committed-core coherence first.
- **The bespoke vault-standalone OAuth UI** at `parachute-vault/src/oauth.ts`. Workstream E (separate parachute-vault PR) is deleting this surface, not bringing it into conformance. Don't touch it here.

### Inheritance rules

When a downstream surface deviates from this doc, the rule is:

1. **First, change this doc** — propose the update in `parachute-patterns/`.
2. **Then, change the surface** — adopt the new convention.
3. **Don't ship a one-off** — even a "small" per-surface palette swap drifts the system. If the deviation is right, lift it into the canon here; if not, don't ship it.

The exception is when a downstream surface discovers a real reason the canonical shape is wrong (a colorblindness contrast issue, a screen-reader regression, etc.). In that case open an issue against this doc, propose the fix here, then adopt downstream.

## 9. Adoption + enforcement

### Per-PR reviewer checks

Per workspace governance ([`governance.md`](./governance.md) rule 3), every PR review surfaces which patterns the change touches. PRs that touch any web surface in Circle 1 or 2 (§8) MUST be checked against this doc. The reviewer agent ([`reviewer-agent.md`](./reviewer-agent.md)) adds the following checks to its UI-surface PR script:

- **Mark** — does the change introduce a new brand mark, retire a legacy one, or use the SVG from §2? If a new mark, why isn't it the canonical one?
- **Palette** — are all new colors sourced from the §3 token table? Hardcoded hex literals outside that table are a flag (allow with rationale; warn loudly).
- **Type** — does the new surface use the right type stack for its auth posture (§4)? Loading Google Fonts on a privacy-safe surface is a fail.
- **Verbs** — does new button / link / page-title copy follow §5? Authorize / Allow / Grant / Connect are flags.
- **States** — if the change touches a state badge or status display, does it use the §6 vocabulary?
- **Components** — does the change reuse the §7 shapes, or invent a parallel one? Inventing is allowed only if the invention belongs back in this doc.

The reviewer doesn't block on small per-cell issues; it surfaces them so the human reviewer (Aaron) can decide whether to fold inline.

### Migration plan

The committed-core web surfaces ranked by gap, biggest first — spanning the four committed-core modules (vault, surface, scribe, hub). Each row is owned by a downstream workstream from the audit's §5 menu.

| Rank | Surface | Gap | Workstream | Owner module |
|---|---|---|---|---|
| 1 | `parachute-surface/web/admin/` (app-admin SPA) | Bespoke `#1e6bb8` blue palette + `15px` body size + square-cornered buttons + uppercase table headers + lowercase-hyphenated `parachute-surface · admin` brand-line. The type stack is the same `-apple-system, …` system-UI cascade as the privacy-safe surfaces (`web/admin/src/styles.css:12`); the outlier is the palette + sizing + radii, not the font family. **The single largest visual outlier in the ecosystem** (audit §2.4). | **B** | parachute-surface |
| 2 | `parachute-hub` brand-marks (`🪂` favicon + `⌬` OAuth + `Parachute Admin` SPA + various per-route headers) | Three competing brand-marks; persistent chrome strip not yet shipped. | **G** (chrome strip) + this doc's §2 retirement list | parachute-hub |
| 3 | CLI + SPA state words (`running`/`stopped`/`-`/`Active`/`Pending-OAuth`/`Disabled`) | Three vocabularies for the same supervisor state. | **F** | parachute-hub (CLI + SPA in one repo) |
| 4 | OAuth flow copy (Authorize/Approve-and-continue/Sign-in-as-admin-to-approve) | Verb drift across the flow's six surfaces. | **I** | parachute-hub |
| 5 | Loading / empty / error treatments (four spinners, four empty states, two banner naming conventions) | Shared components not pulled into a shared sheet. | **J** | parachute-hub (then propagated downstream) |

Per the workspace migration discipline ([`migrations/README.md`](../migrations/README.md)), an architectural shift normally ships with a propagation-checklist file in the same PR. This PR defers that file to the first workstream PR that adopts from this doc — at which point the checklist is created with concrete items covering B/C/F/G/I/J and gets ticked off as each lands. The reason for the deferral: a checklist created here would name the workstreams but couldn't yet name the PRs that satisfy them. This doc is the canon; the propagation checklist follows as the first downstream PR lands.

### `[DRAFT]` brand stubs — what happens to them

The earlier brand stubs (`brand/palette.md`, `brand/typography.md`, `brand/tokens.css`, `brand/motifs.md`) are superseded by this doc. They aren't deleted in this PR — that's a separate cleanup. Options for the cleanup PR:

1. **Delete the stubs** — this doc is the canon; the stubs are stale.
2. **Replace with stubs that point here** — preserve any link-from-the-wild that targets `brand/palette.md`.
3. **Reframe the stubs as the Daily-Flutter-side palette** — Daily uses Forest Green `#40695B` + Fraunces + Inter; the doc could be reframed as "Parachute Daily (mobile)" tokens, separate from the web canon. Whether to keep two palettes is a §10 open question.

The cleanup is not in scope for this PR; flag it as a follow-up.

### Audit script

Run [`scripts/audit-canonical-refs.sh`](../scripts/audit-canonical-refs.sh) after shifts to catch missed propagations. It currently checks for stale committed-core list references; extend it to grep for design-system canon (e.g. `--accent: #(?!4a7c59)`, hardcoded `#1e6bb8`, `font-size: 15px` outside body-default contexts) as workstream B/F land.

## 10. Open questions for branding

The questions that don't block adoption of this doc but need a branding-team answer before the next round.

### 1. Tagline confirmation with branding team

Aaron picked **"Truly personal computing. Your knowledge belongs with you."** 2026-05-25 — this is the in-use canon as of this PR. Worth one more pass with the branding team to confirm the rhythm + the "belongs with you" framing (vs alternatives like "stays yours," "is yours," "your call"). Not a blocker; the canon ships with this doc.

### 2. Custom wordmark for "Parachute"

The wordmark today is just the word **Parachute** set in Instrument Serif. Two options:

- **Keep the type-set wordmark.** Cheap, consistent with how Linear / Notion / Stripe set their wordmarks. The brand-mark + Instrument Serif "Parachute" reads as intentional, not as missing-asset.
- **Commission a custom wordmark.** More distinctive at hero scales; commits to a logo file the way the SVG mark already does. Decoupling the wordmark from a Google-Fonts dependency would also strengthen the privacy-safe stack (today, the wordmark on hub-discovery uses Instrument Serif via Google Fonts; on OAuth surfaces it falls back to Georgia).

No urgency either way. Decision can wait for a branding pass with a designer.

### 3. Mobile + dark-mode coherence pass

This doc specs tokens for both modes (§3) but the audit (§7) noted dark-mode coherence wasn't verified surface-by-surface, and mobile-responsive behavior beyond the existing breakpoints wasn't audited at all. The OAuth flow on a phone (real use case — Notes is a PWA installed to home screen) deserves its own pass before the persistent-chrome-strip (Workstream G) ships, since the chrome strip's 32px height + auth cluster has to read at mobile widths too.

### 4. Two palettes (web canon vs Daily mobile)

The earlier `brand/palette.md` documents the parachute-daily Flutter mobile palette (Forest Green `#40695B` + Fraunces). This doc documents the web canon (sage `#4a7c59` + Instrument Serif). Are these meant to be one palette eventually, or do we accept that mobile-Daily and web-Parachute legitimately have different brand languages? Three answers:

- **One palette, web canon wins.** Re-port the mobile app to sage + Instrument Serif (lots of code change, ship discipline pain).
- **One palette, Daily canon wins.** Re-port every web surface to Forest Green + Fraunces (similar cost, kills the brand-forward typography that already shipped).
- **Two palettes, separate brand languages.** Accept that parachute-daily-the-mobile-app and Parachute-the-web-platform have different audiences and different visual languages; document the boundary explicitly.

Recommend (3) but flag for the branding team. parachute-daily is the only Flutter target in the ecosystem; it's reasonable for it to feel a little different.

### 5. Custom wordmark for the **app** chip

Hub today shows `Parachute · admin` (chip after the wordmark); app would show `Parachute · app` (with `app` chip). The word "app" inside the chip is grammatically lossy — every hosted UI is an "app" in some sense. Is `app` the right chip text, or should it be the more specific name of the host module ("apps" plural? "host"? something else)? Naming team's call.

### 6. Icon set

The audit didn't surface icon usage as a major drift, but it'll matter once the persistent chrome strip ships. Today the SPA uses native unicode symbols (`▾` for dropdown, `›` for chevrons). The Notes PWA uses lucide icons. App-admin uses none. A shared icon set (lucide is the obvious candidate — already in Notes) would unify the icon language across surfaces. Defer until Workstream G needs it.

### 7. Voice + tone beyond verbs

This doc covers the verbs (§5) and state words (§6). It doesn't cover prose voice — the body copy on empty states, the tone of error messages, how technical or how casual to be in operator-facing copy. Worth a sibling pattern (`voice-and-tone.md`?) once two surfaces converge on a voice that feels right.
