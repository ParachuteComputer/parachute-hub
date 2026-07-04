/**
 * Persistent cross-surface chrome strip (workstream G).
 *
 * A 32px-tall top strip injected by hub's proxy middleware on every proxied
 * `text/html` response. Carries `[mark + wordmark] · Home · [signed-in cluster]`
 * so an operator always knows where they are and how to navigate back to the
 * hub root. The structural fix to the "where-am-I confusion" called out in
 * `AUDIT-UI-UX.md` §2.5 + §5 row G, with the HTML + CSS shape pinned in
 * `docs/contracts/design-system.md` §7.
 *
 * Injection mechanism: buffer-and-replace on the first `<body...>` tag.
 * Responses larger than `MAX_INJECT_SIZE_BYTES` are passed through unchanged
 * (above that threshold the response is almost certainly not an HTML shell
 * anyway — SPA index.html files are < 16 KB in this ecosystem).
 *
 * Opt-out: hub-side path-prefix deny list. The Notes PWA at `/surface/notes/*`
 * is the canonical opt-out — it owns its own chrome (see design-system §7
 * "Where NOT to inject" + AUDIT §4: "Notes is the proof this can work: own
 * application, looks distinctively Notes, reads as Parachute because the
 * tokens are continuous").
 *
 * H5 (surface-runtime design): the opt-out generalized — when a UI
 * sub-unit's declared `audience` resolves `public` at the proxy's audience
 * gate (H3), the dispatch passes that mount as an extra opt-out prefix
 * (hub-server `decorateWithChrome`). Public readers aren't hub users; the
 * identity chrome never rides their pages. The static list below remains
 * for hub-users surfaces that own their own chrome (Notes).
 *
 * Why path-based and not module-declared:
 *   - Notes is a `uis[]` sub-unit of parachute-app, not its own module —
 *     adding `chrome: "off"` to parachute-app's module.json would suppress
 *     chrome on `/surface/admin/*` too (wrong: that surface SHOULD get chrome).
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

import { WORDMARK_TEXT, brandMarkSvg } from "./brand.ts";
import { CSRF_FIELD_NAME, ensureCsrfToken } from "./csrf.ts";

/**
 * Path prefixes where chrome injection is suppressed. Match is "pathname ===
 * prefix" or "pathname startsWith prefix" — the same shape as
 * `findServiceUpstream`'s mount comparison.
 *
 * `/surface/notes/` covers the Notes PWA bundled by parachute-app. Notes is a
 * destination, not chrome; it owns its own header (see design-system.md §7).
 */
export const CHROME_OPT_OUT_PREFIXES: readonly string[] = ["/surface/notes/"];

/**
 * Buffer size cap. Responses larger than this are passed through unchanged.
 * 256 KB comfortably accommodates every server-rendered HTML surface in the
 * ecosystem (the largest, hub's discovery page, is ~25 KB) while bounding
 * memory + latency overhead on any large response that incorrectly serves
 * `text/html`.
 */
export const MAX_INJECT_SIZE_BYTES = 256 * 1024;

/**
 * The 16×16 SVG brand mark for the chrome nav. Rendered via the shared
 * `./brand.ts` so hub home, login, OAuth surfaces, and this chrome strip
 * all draw from one source. The clipId suffix `"chrome-1"` keeps this
 * mark's internal `<clipPath>` id distinct from any other mark on the
 * same document (e.g. a hub-owned surface rendering its own mark in its
 * header AND chrome injected over the top — they deduplicate via the
 * `pc-chrome` class check today, but the unique-id discipline is cheap
 * insurance against future refactors).
 */
const BRAND_MARK_SVG = brandMarkSvg(16, "chrome-1");

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
 * Sourced from `docs/contracts/design-system.md` §7 verbatim,
 * with the `:host` token shim added for cross-surface portability.
 */
const CHROME_STYLE = `
.pc-chrome {
  --pc-chrome-bg-soft: var(--bg-soft, #f3f0ea);
  --pc-chrome-border: var(--border, #e4e0d8);
  --pc-chrome-fg: var(--fg, #2c2a26);
  --pc-chrome-fg-muted: var(--fg-muted, #6b6860);
  --pc-chrome-accent: var(--accent, #4a7c59);
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
  return `<style>${CHROME_STYLE}</style><header class="pc-chrome" role="banner"><a href="/" class="pc-chrome-brand"><span class="pc-chrome-mark">${BRAND_MARK_SVG}</span><span class="pc-chrome-wordmark">${WORDMARK_TEXT}</span></a><nav class="pc-chrome-nav" aria-label="primary"><a href="/">Home</a></nav><div class="pc-chrome-auth">${authCluster}</div></header>`;
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
 * Match shape mirrors `findServiceUpstream` so an opt-out for `"/surface/notes/"`
 * suppresses chrome for `/surface/notes`, `/surface/notes/`, and every sub-path.
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
