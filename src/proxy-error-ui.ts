/**
 * HTML + JSON renderers for upstream-unreachable responses (hub#443).
 *
 * Two states, two presentations, two content types — four total responses.
 *
 *   transient + HTML  → 503, branded "Just a moment" page with
 *                       meta-refresh + JS poll of `/api/ready` (max 5
 *                       attempts on a 2s cadence ≈ 10s ceiling). After
 *                       the budget, fall back to a manual Refresh button.
 *
 *   transient + JSON  → 503, `{ error: "upstream_starting", error_type,
 *                       retry_after_ms: 2000, max_attempts: <N> }`
 *                       so an API consumer can drive its own backoff.
 *
 *   persistent + HTML → 502, branded "Module unreachable" page with NO
 *                       auto-retry (it won't help) and a prominent link
 *                       to /admin/modules so the operator can inspect
 *                       logs / restart / etc.
 *
 *   persistent + JSON → 502, `{ error: "upstream_unreachable", error_type,
 *                       admin_url: "/admin/modules" }`.
 *
 * Status codes follow RFC 9110:
 *   - 503 Service Unavailable = "temporary, try again" — pairs with a
 *     `Retry-After` header on the response.
 *   - 502 Bad Gateway         = "upstream broken, retry probably won't
 *                                help" — no Retry-After.
 *
 * Design tokens (`--accent`, `--bg`, `--fg`, etc.) match the OAuth UI +
 * SPA so a wizard interrupt blends visually with the surfaces operators
 * just walked through. See `web/ui/src/styles.css` for the canonical
 * source.
 */

import { WORDMARK_TEXT, brandMarkSvg } from "./brand.ts";
import { escapeHtml } from "./oauth-ui.ts";
import type { UpstreamState } from "./proxy-state.ts";

/** Retry cadence for transient state, in ms. Mirrors meta-refresh content. */
export const TRANSIENT_RETRY_MS = 2_000;

/** Max polls a transient HTML page will run before showing a manual button. */
export const TRANSIENT_MAX_ATTEMPTS = 5;

/** Admin link surfaced on persistent responses. /admin/modules opens the
 * modules pane with per-module status + restart controls. */
export const ADMIN_MODULES_URL = "/admin/modules";

/** JSON error vocabulary. Matches the snake_case shape used elsewhere
 * in the hub's API (`api-modules.ts` etc.) for consistency. */
export const ERROR_TYPE_TRANSIENT = "upstream_starting";
export const ERROR_TYPE_PERSISTENT = "upstream_unreachable";

/** Per-route HTTP status for each upstream state. */
export function statusForState(state: UpstreamState): 502 | 503 {
  return state === "transient" ? 503 : 502;
}

export interface BuildProxyErrorOpts {
  /** Canonical short name (vault/scribe/notes/…). Folded into the response
   *  for operator clarity. */
  short: string;
  /** services.json `name` field — what shipped on the entry. Falls back to
   *  `short` when they coincide. Used in JSON error description. */
  serviceLabel: string;
  /** The classified failure mode. */
  state: UpstreamState;
  /** Raw error message from the failed `fetch()`. Surfaced in JSON so a
   *  consumer can log it; not surfaced in HTML (operators don't read
   *  ECONNREFUSED, the visual cue is enough). */
  upstreamError: string;
}

export interface ProxyErrorResponse {
  body: string;
  status: 502 | 503;
  contentType: string;
  /** Optional Retry-After header value (seconds, per RFC 9110 §10.2.3). */
  retryAfter?: string;
}

/**
 * True iff the caller wants HTML. Mirrors the existing one-line check at
 * `hub-server.ts:2079` rather than introducing a separate negotiation
 * module — the hub's accept handling is uniformly "look for `text/html`"
 * across surfaces.
 */
export function wantsHtml(req: Request): boolean {
  const accept = req.headers.get("accept") ?? "";
  if (accept === "") return true; // No Accept header → assume browser-ish.
  if (accept.includes("application/json") && !accept.includes("text/html")) {
    return false;
  }
  return accept.includes("text/html") || accept.includes("*/*");
}

/**
 * Build the JSON response body for a proxy-error response.
 *
 *   - Transient: includes `retry_after_ms` + `max_attempts` so an API
 *     consumer (CLI, MCP client) can implement its own bounded retry.
 *     `max_attempts` is the ceiling, not a per-request remaining count —
 *     hub doesn't track per-consumer state, so it can't honestly emit a
 *     decrementing counter. The HTML page tracks its own counter
 *     client-side (5 polls then manual fallback); JSON consumers do
 *     the same with this ceiling as the budget.
 *   - Persistent: includes `admin_url` so a developer/operator tool can
 *     surface a "go check the supervisor" affordance.
 */
export function renderProxyErrorJson(opts: BuildProxyErrorOpts): ProxyErrorResponse {
  const status = statusForState(opts.state);
  if (opts.state === "transient") {
    const body = JSON.stringify({
      error: ERROR_TYPE_TRANSIENT,
      error_type: ERROR_TYPE_TRANSIENT,
      error_description: `${opts.serviceLabel} is still starting; retry shortly.`,
      service: opts.short,
      retry_after_ms: TRANSIENT_RETRY_MS,
      max_attempts: TRANSIENT_MAX_ATTEMPTS,
    });
    return {
      body,
      status,
      contentType: "application/json",
      retryAfter: String(Math.ceil(TRANSIENT_RETRY_MS / 1000)),
    };
  }
  const body = JSON.stringify({
    error: ERROR_TYPE_PERSISTENT,
    error_type: ERROR_TYPE_PERSISTENT,
    error_description: `${opts.serviceLabel} upstream unreachable: ${opts.upstreamError}`,
    service: opts.short,
    admin_url: ADMIN_MODULES_URL,
  });
  return {
    body,
    status,
    contentType: "application/json",
  };
}

/**
 * Build the HTML response body for a proxy-error response. Two distinct
 * layouts:
 *
 *   - **Transient**: title "Just a moment", subhead "Loading <module>",
 *     a quiet spinner, a meta-refresh + JS poll that hits `/api/ready`
 *     up to `TRANSIENT_MAX_ATTEMPTS` times at `TRANSIENT_RETRY_MS`
 *     cadence, then a manual "Refresh" button. No admin link.
 *
 *   - **Persistent**: title "Module unreachable", subhead naming the
 *     module, no auto-retry, prominent "View module status" link to
 *     /admin/modules + a manual "Refresh" button. The visual treatment
 *     leans on `--error` / `--error-soft` design tokens.
 */
export function renderProxyErrorHtml(opts: BuildProxyErrorOpts): ProxyErrorResponse {
  const status = statusForState(opts.state);
  const safeShort = escapeHtml(opts.short);
  const safeLabel = escapeHtml(opts.serviceLabel);
  const isTransient = opts.state === "transient";
  const title = isTransient ? "Just a moment" : "Module unreachable";

  const headerVariant = isTransient ? "transient" : "persistent";
  const subheadCopy = isTransient
    ? `<span class="muted">Loading</span> <code>${safeShort}</code><span class="muted">…</span>`
    : `<code>${safeShort}</code> <span class="muted">is not responding right now.</span>`;

  const explanation = isTransient
    ? `<p class="explanation">The hub is still bringing up the <code>${safeLabel}</code> module. This usually resolves within a few seconds. We'll refresh automatically.</p>`
    : `<p class="explanation">The hub couldn't reach the <code>${safeLabel}</code> module. It may have crashed, failed to start, or been stopped. Check the module's status for logs and a restart option.</p>`;

  const metaRefresh = isTransient
    ? `<meta http-equiv="refresh" content="${Math.ceil(TRANSIENT_RETRY_MS / 1000)}">`
    : "";

  const spinnerOrIcon = isTransient
    ? `<div class="status-indicator status-transient" aria-hidden="true"><span class="spinner"></span></div>`
    : `<div class="status-indicator status-persistent" aria-hidden="true"><span class="error-icon">!</span></div>`;

  const actionsHtml = isTransient
    ? `
      <div class="actions" id="actions-transient">
        <p class="poll-status" id="poll-status">Checking again in <span id="poll-countdown">${Math.ceil(
          TRANSIENT_RETRY_MS / 1000,
        )}</span>s… <span class="muted">(attempt <span id="poll-attempt">1</span> of ${TRANSIENT_MAX_ATTEMPTS})</span></p>
      </div>
      <div class="actions" id="actions-give-up" hidden>
        <p class="give-up-copy">Still loading. <button type="button" class="btn btn-primary" id="manual-refresh">Refresh now</button></p>
      </div>`
    : `
      <div class="actions">
        <a href="${ADMIN_MODULES_URL}" class="btn btn-primary">View module status</a>
        <button type="button" class="btn btn-secondary" id="manual-refresh">Refresh</button>
      </div>`;

  // The poll script only emits for transient state. It:
  //   1. Polls /api/ready every TRANSIENT_RETRY_MS.
  //   2. On `ready: true` for our module, reloads the page (which now
  //      proxies through successfully).
  //   3. After TRANSIENT_MAX_ATTEMPTS, swaps the "Checking…" UI for the
  //      manual "Refresh now" button.
  // Defensive: any fetch error counts as a missed attempt — we don't want
  // a `/api/ready` outage to lock the page in a permanent "still loading"
  // state.
  const pollScript = isTransient
    ? `
      <script>
        (function () {
          var maxAttempts = ${TRANSIENT_MAX_ATTEMPTS};
          var intervalMs = ${TRANSIENT_RETRY_MS};
          var short = ${JSON.stringify(opts.short)};
          var attempt = 1;
          var elCountdown = document.getElementById('poll-countdown');
          var elAttempt = document.getElementById('poll-attempt');
          var elActive = document.getElementById('actions-transient');
          var elGiveUp = document.getElementById('actions-give-up');
          var elManualBtn = document.getElementById('manual-refresh');
          var countdown = Math.ceil(intervalMs / 1000);
          var countdownTimer = setInterval(function () {
            countdown -= 1;
            if (countdown <= 0) countdown = Math.ceil(intervalMs / 1000);
            if (elCountdown) elCountdown.textContent = String(countdown);
          }, 1000);
          function giveUp() {
            clearInterval(countdownTimer);
            if (elActive) elActive.hidden = true;
            if (elGiveUp) elGiveUp.hidden = false;
          }
          function poll() {
            if (attempt > maxAttempts) {
              giveUp();
              return;
            }
            fetch('/api/ready', { headers: { accept: 'application/json' }, cache: 'no-store' })
              .then(function (r) { return r.ok ? r.json() : null; })
              .then(function (data) {
                if (data && data.ready) {
                  window.location.reload();
                  return;
                }
                // Module-specific check: if /api/ready lists our short in
                // ready_modules we can reload too.
                if (data && Array.isArray(data.ready_modules) && data.ready_modules.indexOf(short) !== -1) {
                  window.location.reload();
                  return;
                }
                attempt += 1;
                if (elAttempt) elAttempt.textContent = String(attempt);
                if (attempt > maxAttempts) giveUp();
              })
              .catch(function () {
                attempt += 1;
                if (elAttempt) elAttempt.textContent = String(attempt);
                if (attempt > maxAttempts) giveUp();
              });
          }
          // Single timer source: setInterval fires every intervalMs and
          // self-stops at maxAttempts. The previous shape armed BOTH a
          // setTimeout AND a setInterval at the same cadence — they
          // double-fired at T+intervalMs, racing the attempt counter and
          // reaching the giveUp ceiling in ~6s instead of the designed 10s.
          // Reviewer-flagged on #443.
          var pollTimer = setInterval(function () {
            if (attempt > maxAttempts) {
              clearInterval(pollTimer);
              return;
            }
            poll();
          }, intervalMs);
          if (elManualBtn) {
            elManualBtn.addEventListener('click', function () { window.location.reload(); });
          }
        }());
      </script>`
    : `
      <script>
        (function () {
          var btn = document.getElementById('manual-refresh');
          if (btn) btn.addEventListener('click', function () { window.location.reload(); });
        }());
      </script>`;

  const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="referrer" content="no-referrer" />
  ${metaRefresh}
  <style>${PROXY_ERROR_STYLES}</style>
</head>
<body>
  <main>
    <div class="card card-${headerVariant}">
      <div class="card-header">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true">${brandMarkSvg(20, `proxy-${headerVariant}`)}</span>
          <span class="brand-name">${WORDMARK_TEXT}</span>
        </div>
        ${spinnerOrIcon}
        <h1>${escapeHtml(title)}</h1>
        <p class="subtitle">${subheadCopy}</p>
      </div>
      ${explanation}
      ${actionsHtml}
    </div>
  </main>
  ${pollScript}
</body>
</html>`;

  const headers: ProxyErrorResponse = {
    body,
    status,
    contentType: "text/html; charset=utf-8",
  };
  if (isTransient) {
    headers.retryAfter = String(Math.ceil(TRANSIENT_RETRY_MS / 1000));
  }
  return headers;
}

/**
 * Dispatch between HTML + JSON renderers based on the request's Accept
 * header. Single entry point used by `proxyRequest`.
 */
export function renderProxyError(req: Request, opts: BuildProxyErrorOpts): ProxyErrorResponse {
  return wantsHtml(req) ? renderProxyErrorHtml(opts) : renderProxyErrorJson(opts);
}

/**
 * Construct the actual Response from a ProxyErrorResponse. Pulled out so
 * tests can assert on the body shape without re-deriving the headers.
 */
export function toResponse(out: ProxyErrorResponse): Response {
  const headers: Record<string, string> = {
    "content-type": out.contentType,
    "cache-control": "no-store",
  };
  if (out.retryAfter) headers["retry-after"] = out.retryAfter;
  return new Response(out.body, { status: out.status, headers });
}

const PROXY_ERROR_STYLES = `
  :root {
    --bg: #faf8f4;
    --bg-soft: #f3f0ea;
    --fg: #2c2a26;
    --fg-muted: #6b6860;
    --fg-dim: #9a9690;
    --accent: #4a7c59;
    --accent-soft: rgba(74, 124, 89, 0.08);
    --accent-hover: #3d6849;
    --border: #e4e0d8;
    --card-bg: #ffffff;
    --error: #a3392b;
    --error-soft: rgba(163, 57, 43, 0.08);
    --warn: #b08023;
    --warn-soft: rgba(176, 128, 35, 0.08);
  }
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: var(--bg);
    color: var(--fg);
    line-height: 1.55;
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
  }
  main {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 1.5rem;
  }
  .card {
    width: 100%;
    max-width: 30rem;
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 2rem 1.75rem;
    box-shadow: 0 1px 2px rgba(44, 42, 38, 0.04), 0 8px 24px rgba(44, 42, 38, 0.06);
    text-align: center;
  }
  .card-header { margin-bottom: 1.25rem; }
  .brand {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    color: var(--accent);
    font-weight: 500;
    font-size: 0.95rem;
    margin-bottom: 1.5rem;
  }
  .brand-mark { display: inline-flex; line-height: 0; }
  .brand-mark svg { width: 20px; height: 20px; }
  .status-indicator {
    width: 56px;
    height: 56px;
    margin: 0 auto 1.25rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
  }
  .status-transient {
    background: var(--accent-soft);
  }
  .status-persistent {
    background: var(--error-soft);
    color: var(--error);
    font-family: Georgia, "Times New Roman", serif;
    font-size: 1.75rem;
    font-weight: 600;
  }
  .spinner {
    width: 24px;
    height: 24px;
    border: 2.5px solid var(--accent-soft);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  h1 {
    font-family: Georgia, "Times New Roman", serif;
    font-weight: 400;
    font-size: 1.6rem;
    line-height: 1.2;
    margin: 0 0 0.5rem;
    color: var(--fg);
  }
  .subtitle {
    margin: 0;
    color: var(--fg-muted);
    font-size: 0.95rem;
  }
  .subtitle code, .explanation code {
    font-family: ui-monospace, "SF Mono", Menlo, Monaco, monospace;
    background: var(--bg-soft);
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    font-size: 0.85em;
    color: var(--fg);
  }
  .muted { color: var(--fg-dim); }
  .explanation {
    color: var(--fg-muted);
    font-size: 0.92rem;
    margin: 0 0 1.5rem;
    text-align: left;
  }
  .actions {
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
    align-items: stretch;
  }
  .poll-status {
    margin: 0;
    color: var(--fg-muted);
    font-size: 0.88rem;
    text-align: center;
  }
  .give-up-copy {
    color: var(--fg-muted);
    font-size: 0.92rem;
    margin: 0;
    text-align: center;
  }
  .btn {
    display: inline-block;
    font: inherit;
    border-radius: 6px;
    padding: 0.55rem 1.1rem;
    cursor: pointer;
    text-decoration: none;
    text-align: center;
    border: 1px solid transparent;
    transition: background 0.15s ease, border-color 0.15s ease;
  }
  .btn-primary {
    background: var(--accent);
    color: white;
    border-color: var(--accent);
  }
  .btn-primary:hover {
    background: var(--accent-hover);
    border-color: var(--accent-hover);
  }
  .btn-secondary {
    background: white;
    color: var(--fg);
    border-color: var(--border);
  }
  .btn-secondary:hover {
    background: var(--bg-soft);
  }
`;
