/**
 * Persistent cross-surface chrome strip (workstream G).
 *
 * A 32px-tall top strip injected by hub's proxy middleware on every proxied
 * `text/html` response. Carries `[mark + wordmark] · Home · [signed-in cluster]`
 * so an operator always knows where they are and how to navigate back to the
 * hub root. The structural fix to the "where-am-I confusion" called out in
 * `AUDIT-UI-UX.md` §2.5 + §5 row G, with the HTML + CSS shape pinned in
 * `parachute-patterns/patterns/design-system.md` §7.
 *
 * Injection mechanism: buffer-and-replace on the first `<body...>` tag.
 * Responses larger than `MAX_INJECT_SIZE_BYTES` are passed through unchanged
 * (above that threshold the response is almost certainly not an HTML shell
 * anyway — SPA index.html files are < 16 KB in this ecosystem).
 *
 * Opt-out: hub-side path-prefix deny list. The Notes PWA at `/app/notes/*`
 * is the canonical opt-out — it owns its own chrome (see design-system §7
 * "Where NOT to inject" + AUDIT §4: "Notes is the proof this can work: own
 * application, looks distinctively Notes, reads as Parachute because the
 * tokens are continuous").
 *
 * Why path-based and not module-declared:
 *   - Notes is a `uis[]` sub-unit of parachute-app, not its own module —
 *     adding `chrome: "off"` to parachute-app's module.json would suppress
 *     chrome on `/app/admin/*` too (wrong: that surface SHOULD get chrome).
 *   - The per-uis well-known fan-out (workstream C/4) is in flight but the
 *     hub side doesn't yet thread per-uis metadata into proxy dispatch.
 *   - HTML meta-tag peeking adds parsing overhead on every response.
 *   - Path-prefix is the smallest defensible primitive that covers Notes
 *     today and stays easy to extend (or migrate to per-uis declaration
 *     once that path lands).
 *
 * Idempotence: if the response body already contains `class="pc-chrome"`
 * (e.g. a hub-owned surface that renders the chrome itself), injection is
 * a no-op. This lets hub.ts / oauth-ui.ts / setup-wizard.ts adopt the
 * strip in their own templates without double-rendering when the proxy
 * middleware runs over their output (which it doesn't today, but the
 * defense is cheap and protects future refactors).
 */

import { ensureCsrfToken } from "./csrf.ts";
import { CSRF_FIELD_NAME } from "./csrf.ts";

/**
 * Path prefixes where chrome injection is suppressed. Match is "pathname ===
 * prefix" or "pathname startsWith prefix" — the same shape as
 * `findServiceUpstream`'s mount comparison.
 *
 * `/app/notes/` covers the Notes PWA bundled by parachute-app. Notes is a
 * destination, not chrome; it owns its own header (see design-system.md §7).
 */
export const CHROME_OPT_OUT_PREFIXES: readonly string[] = ["/app/notes/"];

/**
 * Buffer size cap. Responses larger than this are passed through unchanged.
 * 256 KB comfortably accommodates every server-rendered HTML surface in the
 * ecosystem (the largest, hub's discovery page, is ~25 KB) while bounding
 * memory + latency overhead on any large response that incorrectly serves
 * `text/html`.
 */
export const MAX_INJECT_SIZE_BYTES = 256 * 1024;

/**
 * The 16×16 SVG brand mark (workstream G uses the chrome-nav recommended
 * size). Sourced verbatim from `parachute-patterns/patterns/design-system.md`
 * §2 — `fill="currentColor"` so the mark inherits the surrounding text
 * color and renders correctly in dark mode.
 */
const BRAND_MARK_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><g clip-path="url(#pc-chrome-mark-clip)"><path d="M23.1599 14.9453C22.7429 14.9429 22.3775 15.2985 22.375 15.7204C22.3726 16.1374 22.7282 16.5028 23.1501 16.5053C23.567 16.5077 23.9325 16.1521 23.935 15.7302C23.9374 15.3108 23.5793 14.9478 23.1599 14.9453Z" fill="currentColor"/><path d="M15.758 22.3758C15.3435 22.3562 14.9657 22.702 14.9461 23.1214C14.9265 23.5359 15.2723 23.9137 15.6917 23.9333C16.1063 23.9529 16.484 23.6071 16.5036 23.1877C16.5232 22.7731 16.1774 22.3954 15.758 22.3758Z" fill="currentColor"/><path d="M23.1208 9.08552C23.5721 9.10024 23.9375 8.76176 23.9473 8.31291C23.9571 7.86161 23.6137 7.50351 23.1649 7.49615C22.7308 7.49124 22.3825 7.81746 22.3604 8.24668C22.3383 8.70044 22.6744 9.06835 23.1208 9.08307V9.08552Z" fill="currentColor"/><path d="M8.32678 22.3598C7.87547 22.3451 7.51002 22.6836 7.50021 23.1324C7.49039 23.5837 7.83378 23.9418 8.28263 23.9492C8.73393 23.9541 9.08712 23.6058 9.08712 23.1545C9.08712 22.7032 8.75601 22.3746 8.32678 22.3598Z" fill="currentColor"/><path d="M23.1502 12.8994C23.6113 12.9019 24.0135 12.4947 24.0013 12.0361C23.9914 11.5897 23.6039 11.2095 23.16 11.207C22.6989 11.2046 22.2966 11.6117 22.3089 12.0704C22.3187 12.5143 22.7062 12.897 23.1502 12.8994Z" fill="currentColor"/><path d="M12.9002 23.1849C12.9198 22.7459 12.5568 22.3436 12.1079 22.3068C11.6542 22.2725 11.2299 22.6551 11.2078 23.1162C11.1882 23.5553 11.5512 23.9575 12 23.9943C12.4538 24.0287 12.8781 23.646 12.9002 23.1849Z" fill="currentColor"/><path d="M19.4899 20.3568C19.9829 20.3544 20.368 19.9595 20.3582 19.464C20.3508 18.9882 19.9755 18.6129 19.4997 18.6056C19.0067 18.5982 18.6118 18.9833 18.6094 19.4763C18.6094 19.9693 18.9969 20.3593 19.4899 20.3544V20.3568Z" fill="currentColor"/><path d="M0.946568 14.8555C0.483002 14.8555 0.0881117 15.243 0.0783008 15.7066C0.0684898 16.1873 0.470738 16.5994 0.951474 16.5969C1.41504 16.5969 1.80993 16.2094 1.81974 15.7458C1.82955 15.2651 1.4273 14.853 0.946568 14.8555Z" fill="currentColor"/><path d="M15.6895 1.82027C16.1678 1.83989 16.5872 1.445 16.597 0.964263C16.6044 0.500696 16.2267 0.0984479 15.7631 0.0788261C15.2848 0.0592042 14.8654 0.454094 14.8556 0.93483C14.8482 1.3984 15.2259 1.80065 15.6895 1.82027Z" fill="currentColor"/><path d="M0.928315 9.18321C1.44829 9.19302 1.84073 8.81285 1.84073 8.29532C1.84073 7.79742 1.47037 7.41479 0.974917 7.40253C0.454937 7.39272 0.0625 7.77289 0.0625 8.29042C0.0625 8.79078 0.432863 9.17095 0.928315 9.18321Z" fill="currentColor"/><path d="M8.33104 0.0630625C7.81106 0.0458934 7.41126 0.423614 7.40636 0.938689C7.399 1.43905 7.76691 1.82658 8.25991 1.84129C8.76272 1.85601 9.15761 1.50036 9.18459 1.00982C9.21157 0.489838 8.84121 0.0777789 8.33349 0.0630625H8.33104Z" fill="currentColor"/><path d="M19.483 3.67042C18.9728 3.67042 18.5362 4.1021 18.5313 4.61227C18.524 5.11999 18.9532 5.56148 19.4634 5.57374C19.9858 5.58846 20.4445 5.1347 20.4371 4.60982C20.4298 4.09965 19.9932 3.66797 19.483 3.66797V3.67042Z" fill="currentColor"/><path d="M0.976227 11.102C0.456247 11.0849 -0.00486668 11.5411 3.87869e-05 12.0611C0.00494425 12.5663 0.441531 13.0029 0.946794 13.0029C1.45206 13.0029 1.8911 12.5737 1.90091 12.066C1.91072 11.5631 1.48394 11.1192 0.976227 11.102Z" fill="currentColor"/><path d="M12.0584 4.16361e-05C11.5531 -0.00486383 11.1116 0.424365 11.1018 0.93208C11.0895 1.45206 11.5457 1.91072 12.0657 1.90091C12.571 1.8911 13.0051 1.45206 13.0002 0.946797C12.9978 0.441534 12.5636 0.0049471 12.0584 4.16361e-05Z" fill="currentColor"/><path d="M4.65891 18.5322C4.13894 18.5077 3.67046 18.9516 3.66801 19.479C3.6631 19.9867 4.09233 20.4257 4.6025 20.438C5.11022 20.4478 5.55416 20.0259 5.57133 19.5133C5.59095 19.0081 5.16908 18.5567 4.65891 18.5322Z" fill="currentColor"/><path d="M4.58641 5.65236C5.13337 5.67443 5.62637 5.21332 5.64845 4.65654C5.67052 4.10959 5.20941 3.61659 4.65264 3.59451C4.10568 3.57244 3.61268 4.03355 3.5906 4.59032C3.56853 5.13728 4.02964 5.63028 4.58641 5.65236Z" fill="currentColor"/><path d="M19.5008 16.8099C20.1017 16.8 20.5726 16.3169 20.5677 15.7159C20.5628 15.115 20.087 14.6392 19.4836 14.6367C18.8803 14.6343 18.402 15.1077 18.3946 15.7086C18.3873 16.3267 18.8803 16.8197 19.5008 16.8074V16.8099Z" fill="currentColor"/><path d="M15.7209 20.5694C16.3218 20.5694 16.8025 20.0985 16.8099 19.4976C16.8172 18.8967 16.3488 18.411 15.7478 18.3988C15.1298 18.384 14.6318 18.8746 14.6368 19.4927C14.6417 20.0936 15.1199 20.5694 15.7209 20.5719V20.5694Z" fill="currentColor"/><path d="M9.42652 19.4702C9.41916 18.8644 8.9188 18.364 8.31298 18.3518C7.69243 18.3395 7.1651 18.8546 7.16019 19.4751C7.15529 20.0981 7.67281 20.6157 8.29581 20.6157C8.9188 20.6157 9.43388 20.0908 9.42652 19.4702Z" fill="currentColor"/><path d="M19.4553 7.16016C18.8495 7.17487 18.354 7.68259 18.3516 8.28841C18.3491 8.91141 18.8666 9.42893 19.4896 9.42403C20.1126 9.41912 20.6253 8.89669 20.6154 8.27615C20.6056 7.65316 20.0734 7.14544 19.4553 7.16261V7.16016Z" fill="currentColor"/><path d="M15.7219 5.79748C16.3817 5.79748 16.9115 5.26034 16.8993 4.60055C16.887 3.95793 16.3695 3.44531 15.7244 3.44531C15.0793 3.44531 14.5348 3.98246 14.5471 4.64225C14.5593 5.28732 15.0793 5.79748 15.7219 5.79748Z" fill="currentColor"/><path d="M4.63052 16.9006C5.27559 16.8957 5.78821 16.3806 5.79557 15.738C5.80292 15.0782 5.27068 14.5435 4.6109 14.5509C3.94866 14.5582 3.42623 15.0978 3.44585 15.7576C3.46302 16.4002 3.9879 16.9055 4.63052 16.9006Z" fill="currentColor"/><path d="M12.0637 20.6756C12.7088 20.6683 13.2533 20.1115 13.246 19.4714C13.2386 18.8263 12.6818 18.2818 12.0417 18.2891C11.3966 18.2965 10.8521 18.8533 10.8594 19.4934C10.8668 20.1385 11.4211 20.683 12.0637 20.6756Z" fill="currentColor"/><path d="M19.4762 10.8594C18.8312 10.8618 18.2842 11.4137 18.2891 12.0563C18.2915 12.7014 18.8434 13.2483 19.486 13.2434C20.1311 13.241 20.6781 12.6891 20.6732 12.0465C20.6682 11.4039 20.1188 10.8569 19.4762 10.8594Z" fill="currentColor"/><path d="M8.31147 5.84627C8.98106 5.83645 9.52067 5.28459 9.51576 4.61499C9.51085 3.9454 8.9639 3.40089 8.29675 3.39844C7.62716 3.39844 7.07774 3.93804 7.07038 4.60764C7.06303 5.2944 7.6247 5.85362 8.31147 5.84627Z" fill="currentColor"/><path d="M4.64934 7.0706C3.96257 7.05588 3.39599 7.6102 3.39845 8.29942C3.39845 8.96902 3.94541 9.51597 4.615 9.51843C5.2846 9.52088 5.83646 8.98128 5.84382 8.31168C5.85118 7.64209 5.31648 7.08532 4.64689 7.0706H4.64934Z" fill="currentColor"/><path d="M12.0484 5.91679C12.7376 5.92169 13.3312 5.34285 13.3508 4.64873C13.3704 3.94479 12.7671 3.32916 12.0607 3.32425C11.3715 3.31934 10.7779 3.89819 10.7583 4.59231C10.7387 5.29625 11.3396 5.91434 12.0484 5.91679Z" fill="currentColor"/><path d="M4.58021 13.3473C5.28169 13.3743 5.90469 12.7783 5.91695 12.0695C5.92921 11.3827 5.35528 10.7818 4.66115 10.7548C3.95967 10.7278 3.33668 11.3238 3.32441 12.0327C3.31215 12.7194 3.88609 13.3203 4.58021 13.3473Z" fill="currentColor"/><path d="M15.7193 14.3359C14.9687 14.3359 14.3335 14.9761 14.3359 15.7266C14.3359 16.4772 14.9761 17.1124 15.7266 17.11C16.4772 17.11 17.1124 16.4698 17.11 15.7193C17.1075 14.9687 16.4698 14.3335 15.7193 14.3359Z" fill="currentColor"/><path d="M15.7407 9.73609C16.5428 9.72628 17.1756 9.0763 17.1658 8.27671C17.156 7.47712 16.506 6.84186 15.7064 6.85167C14.9068 6.86149 14.2716 7.51146 14.2814 8.31105C14.2912 9.11064 14.9411 9.7459 15.7407 9.73609Z" fill="currentColor"/><path d="M8.2987 14.2813C7.50156 14.2764 6.8565 14.9165 6.85159 15.7161C6.84669 16.5133 7.48685 17.1583 8.28644 17.1632C9.08358 17.1681 9.72865 16.528 9.73355 15.7284C9.73601 14.9313 9.09584 14.2862 8.2987 14.2813Z" fill="currentColor"/><path d="M8.2854 9.79467C9.12669 9.79712 9.78647 9.15696 9.79874 8.32057C9.811 7.45967 9.15857 6.79007 8.30257 6.78516C7.46128 6.78271 6.8015 7.42533 6.78923 8.25926C6.77697 9.12017 7.4294 9.78976 8.2854 9.79467Z" fill="currentColor"/><path d="M15.7268 10.5156C14.8757 10.5156 14.1644 11.2343 14.184 12.0829C14.2036 12.9242 14.9075 13.6061 15.7415 13.5914C16.5803 13.5766 17.2671 12.8801 17.2622 12.0461C17.2573 11.2097 16.5631 10.5181 15.7268 10.5156Z" fill="currentColor"/><path d="M12.0588 14.1836C11.2077 14.1787 10.4964 14.8998 10.516 15.7485C10.5356 16.5897 11.2371 17.2716 12.0686 17.2593C12.9074 17.2471 13.5942 16.553 13.5917 15.7166C13.5893 14.8802 12.8976 14.1885 12.0612 14.1836H12.0588Z" fill="currentColor"/><path d="M12.0397 6.66802C11.1568 6.67538 10.4356 7.39894 10.4258 8.28192C10.4185 9.17717 11.1666 9.92525 12.0618 9.91789C12.9448 9.91054 13.6659 9.18698 13.6757 8.304C13.6831 7.40875 12.935 6.66066 12.0397 6.66802Z" fill="currentColor"/><path d="M8.29197 13.6757C9.1725 13.6757 9.90096 12.9619 9.91813 12.074C9.9353 11.1812 9.19212 10.4282 8.29442 10.4258C7.41389 10.4258 6.68543 11.1395 6.66826 12.0274C6.65109 12.9202 7.39427 13.6732 8.29197 13.6757Z" fill="currentColor"/><path d="M12.0638 10.2891C11.068 10.2842 10.2905 11.0568 10.293 12.0526C10.293 13.0288 11.0533 13.8014 12.0222 13.8137C13.0204 13.8259 13.8077 13.0631 13.8151 12.0722C13.8225 11.074 13.0548 10.294 12.0638 10.2891Z" fill="currentColor"/></g><defs><clipPath id="pc-chrome-mark-clip"><rect width="24" height="24" fill="white"/></clipPath></defs></svg>`;

/**
 * Canonical CSS for the chrome strip + token shim. Inlined into a single
 * `<style>` so the injected fragment is self-contained (works against
 * surfaces with their own stylesheets that may or may not have declared
 * `--bg-soft` / `--fg` / `--accent` etc.).
 *
 * The token shim block declares fallbacks (cream / ink / sage from the
 * design-system palette) so the chrome renders correctly on a surface that
 * hasn't yet adopted the canonical palette tokens. Once a surface declares
 * `:root { --bg-soft: ...; }` of its own, those win via cascade.
 *
 * Sourced from `parachute-patterns/patterns/design-system.md` §7 verbatim,
 * with the `:host` token shim added for cross-surface portability.
 */
const CHROME_STYLE = `
.pc-chrome {
  --pc-chrome-bg-soft: var(--bg-soft, #f5efe0);
  --pc-chrome-border: var(--border, #d8cfb8);
  --pc-chrome-fg: var(--fg, #2a2723);
  --pc-chrome-fg-muted: var(--fg-muted, #6b6760);
  --pc-chrome-accent: var(--accent, #6b8f5e);
  --pc-chrome-serif: var(--serif, var(--font-serif, Georgia, "Times New Roman", serif));
  --pc-chrome-sans: var(--sans, var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif));
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
  font-family: var(--pc-chrome-sans);
  box-sizing: border-box;
}
.pc-chrome * { box-sizing: border-box; }
.pc-chrome-brand {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  color: var(--pc-chrome-fg);
  text-decoration: none;
  font-weight: 500;
}
.pc-chrome-brand .pc-chrome-wordmark {
  font-family: var(--pc-chrome-serif);
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
.pc-chrome-signout-form { display: inline; margin: 0; padding: 0; }
`.trim();

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export interface ChromeStripOptions {
  /** Display name for the active session, or undefined when signed out. */
  readonly displayName?: string;
  /** CSRF token for the sign-out form. Required when `displayName` is set. */
  readonly csrfToken?: string;
  /**
   * The current request path. Threaded into the `/login?next=<path>` link so
   * a signed-out operator returns to the surface they were viewing after
   * signing in. Defaults to `/` (the hub home) when omitted.
   */
  readonly nextPath?: string;
}

/**
 * Render the chrome strip HTML fragment (no `<html>` / `<head>` wrapper —
 * this is the piece injected into existing pages right after `<body>`).
 *
 * Includes a self-contained `<style>` block so the strip renders correctly
 * even on surfaces that haven't yet adopted the canonical palette tokens.
 */
export function renderChromeStrip(opts: ChromeStripOptions): string {
  const authCluster =
    opts.displayName && opts.csrfToken
      ? renderSignedInCluster(opts.displayName, opts.csrfToken)
      : renderSignedOutCluster(opts.nextPath ?? "/");
  return `<style>${CHROME_STYLE}</style><header class="pc-chrome" role="banner"><a href="/" class="pc-chrome-brand"><span class="pc-chrome-mark">${BRAND_MARK_SVG}</span><span class="pc-chrome-wordmark">Parachute</span></a><nav class="pc-chrome-nav" aria-label="primary"><a href="/">Home</a></nav><div class="pc-chrome-auth">${authCluster}</div></header>`;
}

function renderSignedInCluster(displayName: string, csrfToken: string): string {
  return `<span>Signed in as <strong>${escapeHtml(displayName)}</strong></span><form method="POST" action="/logout" class="pc-chrome-signout-form"><input type="hidden" name="${CSRF_FIELD_NAME}" value="${escapeAttr(csrfToken)}" /><button type="submit">Sign out</button></form>`;
}

function renderSignedOutCluster(nextPath: string): string {
  const safeNext = encodeURIComponent(nextPath || "/");
  return `<a href="/login?next=${safeNext}">Sign in</a>`;
}

/**
 * Test whether chrome injection should run for `pathname`. Returns `false`
 * when any opt-out prefix matches (`pathname === prefix` or
 * `pathname startsWith prefix`).
 *
 * Match shape mirrors `findServiceUpstream` so an opt-out for `"/app/notes/"`
 * suppresses chrome for `/app/notes`, `/app/notes/`, and every sub-path.
 */
export function shouldInjectChrome(
  pathname: string,
  optOutPrefixes: readonly string[] = CHROME_OPT_OUT_PREFIXES,
): boolean {
  for (const raw of optOutPrefixes) {
    const norm = raw.replace(/\/+$/, "") || "/";
    if (pathname === norm || pathname.startsWith(`${norm}/`)) return false;
  }
  return true;
}

/**
 * Insert `chromeHtml` after the first `<body...>` tag in `html`.
 *
 *  - When `html` has no `<body>` tag, returns the original string unchanged.
 *    (Edge case: HTML fragments served as `text/html` without a full doc
 *    shell. The chrome can't sticky-position correctly without a `<body>`
 *    anchor, so we'd rather skip than emit malformed output.)
 *  - When `html` already contains `class="pc-chrome"`, returns the original
 *    string unchanged (idempotence — see header comment).
 *  - Handles `<body>`, `<BODY>`, `<body class="...">`, and `<body
 *    data-foo="...">` shapes via a non-greedy attribute match.
 */
export function injectChromeIntoHtml(html: string, chromeHtml: string): string {
  if (html.includes('class="pc-chrome"')) return html;
  // Non-greedy attribute match; case-insensitive. Captures up through the
  // closing `>` of the opening `<body>` tag.
  const match = html.match(/<body\b[^>]*>/i);
  if (!match || match.index === undefined) return html;
  const tagEnd = match.index + match[0].length;
  return html.slice(0, tagEnd) + chromeHtml + html.slice(tagEnd);
}

export interface InjectIntoResponseOptions {
  /** Chrome HTML fragment from `renderChromeStrip`. */
  readonly chromeHtml: string;
  /** Pathname of the original request — used for the opt-out check. */
  readonly pathname: string;
  /** Optional override of the path-prefix opt-out list. */
  readonly optOutPrefixes?: readonly string[];
  /** Optional override of the max size threshold (for tests). */
  readonly maxSizeBytes?: number;
}

/**
 * Buffer the response body, inject chrome into the first `<body...>` tag,
 * and return a new `Response` with the rewritten body. Pass-through (the
 * original response is returned untouched) when:
 *
 *   - The pathname matches an opt-out prefix.
 *   - The response status is not 200 (chrome on a 404/500 would look
 *     misleading — those error surfaces should remain unchanged for now;
 *     a future revision could inject on hub-owned error pages).
 *   - Content-Type is not `text/html` (covers JSON, JS, CSS, images).
 *   - Content-Length declares a body larger than `maxSizeBytes`.
 *   - After buffering, the body exceeds `maxSizeBytes`.
 *   - The HTML lacks a `<body>` tag (fragment shape; injection would emit
 *     malformed output).
 *
 * On any pass-through path the original response is returned as-is so
 * callers don't need to branch on the result.
 */
export async function injectChromeIntoResponse(
  res: Response,
  opts: InjectIntoResponseOptions,
): Promise<Response> {
  const maxBytes = opts.maxSizeBytes ?? MAX_INJECT_SIZE_BYTES;
  const optOuts = opts.optOutPrefixes ?? CHROME_OPT_OUT_PREFIXES;

  if (!shouldInjectChrome(opts.pathname, optOuts)) return res;
  // Don't rewrite redirects, 4xx, 5xx — chrome on an error/redirect body
  // is misleading and the body itself may not be HTML even when the
  // content-type header claims otherwise (e.g. error pages emitted by an
  // upstream that 404s before its own HTML renderer runs).
  if (res.status !== 200) return res;
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/html")) return res;
  // Heuristic short-circuit: when the upstream declared a Content-Length
  // larger than the cap, skip the buffer entirely (avoids reading a multi-MB
  // body just to throw it back unchanged).
  const declaredLen = res.headers.get("content-length");
  if (declaredLen) {
    const n = Number(declaredLen);
    if (Number.isFinite(n) && n > maxBytes) return res;
  }

  // Bun's Response.arrayBuffer() drains the body; once drained the original
  // Response can't be re-used. We construct a fresh Response from the
  // (possibly rewritten) buffer, preserving status + headers.
  const buf = await res.arrayBuffer();
  if (buf.byteLength > maxBytes) {
    return new Response(buf, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }

  const html = new TextDecoder("utf-8").decode(buf);
  const rewritten = injectChromeIntoHtml(html, opts.chromeHtml);
  if (rewritten === html) {
    // No-op (no <body>, already injected, etc.) — return the original bytes
    // verbatim so we don't alter a stable byte-for-byte response.
    return new Response(buf, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }

  // Strip Content-Length: we rewrote the body, the header is now wrong.
  // (Bun will emit a fresh one based on the body bytes.) Preserve every
  // other header — cache-control, set-cookie, x-* etc. from the upstream.
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(rewritten, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/**
 * Build a `ChromeStripOptions` for an incoming `Request` from the active
 * session (if any). Mirrors the lookup done in `hub-server.ts`'s `/` handler.
 *
 * The DB + CSRF-ensure machinery is threaded through optional callbacks so
 * the helper stays test-friendly (no implicit module-level state).
 *
 * Returns `{ chromeHtml, setCookie? }`:
 *   - `chromeHtml` is the rendered fragment ready to feed into
 *     `injectChromeIntoResponse`.
 *   - `setCookie` is set when `ensureCsrfToken` minted a fresh CSRF cookie;
 *     callers must attach it to the outgoing response so the sign-out form
 *     POST can verify on submit.
 */
export interface ChromeForRequestDeps {
  readonly findActiveSession: (req: Request) => { userId: string } | null;
  readonly getUsername: (userId: string) => string | null;
}

export function buildChromeForRequest(
  req: Request,
  deps: ChromeForRequestDeps,
): { chromeHtml: string; setCookie?: string } {
  const url = new URL(req.url);
  const nextPath = url.pathname + url.search;
  const session = deps.findActiveSession(req);
  if (!session) {
    return { chromeHtml: renderChromeStrip({ nextPath }) };
  }
  const username = deps.getUsername(session.userId);
  if (!username) {
    return { chromeHtml: renderChromeStrip({ nextPath }) };
  }
  const csrf = ensureCsrfToken(req);
  return {
    chromeHtml: renderChromeStrip({
      displayName: username,
      csrfToken: csrf.token,
      nextPath,
    }),
    setCookie: csrf.setCookie,
  };
}
