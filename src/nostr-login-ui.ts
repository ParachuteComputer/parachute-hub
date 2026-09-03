/**
 * The browser side of the human key door — row 4 of the design note
 * `Design/Human key door — sign in with a Nostr key`
 * (https://parachute.techne.coop/n/01M1J1CHW7KM8FD35FR1AH06HK).
 *
 * hub#949 shipped rows 1–3: `GET /api/auth/nostr/challenge` hands out a nonce
 * plus the exact kind-27235 event to sign, and `POST /api/auth/nostr/verify`
 * turns a signature over that event into the SAME session cookie the password
 * doors mint. Nothing rendered HTML. This file is the missing half: a
 * "Sign in with Nostr key" affordance on both hub login pages plus the small
 * script that runs the ceremony.
 *
 * ## Why the markup and the script live together in one module
 *
 * The button's element ids, the `data-next` contract, and the error strings
 * are one thing that happens to be spelled in two languages. Splitting them
 * across `admin-login-ui.ts` and `oauth-ui.ts` would give the two login pages
 * two chances to drift. Both pages call {@link renderNostrKeyDoor} and get an
 * identical door.
 *
 * ## Delivery: an inline script, deliberately
 *
 * The design note's §2 calls for "a button plus an inline script"; inline
 * script is the established pattern on these server-rendered pre-auth pages
 * (`oauth-ui.ts`'s copy-link button, `admin-login-ui.ts`'s invite-form vault
 * prefill), which exist precisely so a brand-new member with no SPA shell and
 * no bundle can still act.
 *
 * This is CSP-safe here. The hub's only CSP is hub#643 Tier-1, and it is
 * stamped by `withProxySecurityHeaders` on PROXIED `text/html` — the per-vault
 * and services-mount proxies. `/login` and `/oauth/authorize` are rendered by
 * the hub itself and never pass through that chokepoint, so they carry no CSP
 * at all. Even if they did, the Tier-1 policy is
 * `frame-ancestors 'self'; object-src 'none'; base-uri 'self'` with
 * deliberately NO `script-src` (Tier-2, explicitly deferred), so an inline
 * script would still execute. Nothing here needs a nonce, and no new static
 * asset route is introduced — which also keeps `hub-server.ts` untouched
 * except for the one additive `/login/2fa` GET line.
 *
 * If Tier-2 ever lands a strict `script-src`, this is the one place to change:
 * {@link nostrLoginClientScript} already returns the bare JS source, so
 * serving it from a file (or stamping it with a nonce) is a change to
 * {@link renderNostrKeyDoor} alone.
 *
 * ## Progressive enhancement
 *
 * The password form is untouched and keeps working with JS off. The key-door
 * section is emitted `hidden` AND its button `disabled`, and only the script
 * un-hides it — so a no-JS browser sees exactly today's page, and never an
 * inert button that does nothing when clicked. With JS but no NIP-07 signer
 * the section IS shown, with the button disabled and a one-line hint, because
 * the design note's proving test for this row is "absent-extension state is
 * legible" — a member who was told to sign in with their key needs to be told
 * why they can't, not shown nothing.
 *
 * ## Three states, one element
 *
 *   no JS              → section hidden, button disabled (today's page)
 *   JS, no window.nostr → section shown, button disabled, install hint
 *   JS + window.nostr   → section shown, button live
 *
 * Extensions inject `window.nostr` at wildly different times (document_start
 * for most, after first paint for a few), so the script re-checks on a short
 * backoff before it settles on the "no signer" hint.
 */
/**
 * Local, deliberately NOT `oauth-ui.ts`'s `escapeHtml`. Both login-page
 * modules import THIS module for their styles at module-evaluation time, so
 * importing back out of `oauth-ui.ts` would make a cycle in which
 * `NOSTR_LOGIN_STYLES` could be read in its temporal dead zone. This module
 * imports nothing; that is the whole defence. Same rule set as
 * `admin-login-ui.ts`'s own `escapeAttr` — `&`, `"`, `<`, which is sufficient
 * for a double-quoted attribute value.
 */
function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** DOM ids the markup and the script agree on. Exported so tests assert one spelling. */
export const NOSTR_LOGIN_SECTION_ID = "nostr-signin";
export const NOSTR_LOGIN_BUTTON_ID = "nostr-signin-button";
export const NOSTR_LOGIN_STATUS_ID = "nostr-signin-status";

/** Paths the script calls. Same constants `nostr-login.ts` mounts on. */
const CHALLENGE_PATH = "/api/auth/nostr/challenge";
const VERIFY_PATH = "/api/auth/nostr/verify";

/**
 * Human sentence per wire error code from `nostr-login.ts`.
 *
 * The rule the design note's UX asks for: never show a raw code alone. A code
 * is for a log; a member staring at a login page needs to know whether to
 * click again, pick a different key, or go ask their operator — so every
 * message ends in an action.
 *
 * `unknown_pubkey` gets the longest one on purpose: it is the design note's §4
 * dead end, the single most likely thing a first-time cooperative member hits,
 * and the two remedies (an operator runs `parachute auth link-pubkey`, or the
 * member joins a channel-attached vault) are not guessable from "unknown".
 */
export const NOSTR_LOGIN_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  too_many_attempts: "Too many sign-in attempts from this device. Wait a minute and try again.",
  invalid_request: "The sign-in request was malformed. Reload this page and try again.",
  invalid_event:
    "Your signer returned an event this hub can't accept. Reload this page and try again.",
  proof_failed:
    "That signature didn't prove you hold this key. Check which account your signer is set to, then try again.",
  unknown_challenge:
    "That sign-in request was already used. Click the button again for a fresh one.",
  challenge_expired:
    "The sign-in request expired. Click the button again and approve it within five minutes.",
  unknown_pubkey:
    "No account on this hub is linked to that Nostr key. Ask your hub operator to link it, or join a channel whose vault is attached to this hub.",
  csrf_origin_mismatch:
    "This page was loaded from a different address than the hub answers on. Open the hub's own address and try again.",
  method_not_allowed: "This hub's key door answered unexpectedly. Reload this page and try again.",
  not_found:
    "This hub doesn't have the Nostr key door enabled. Sign in with your username and password.",
};

/** Shown when the code is absent or unrecognized and the server sent no description. */
export const NOSTR_LOGIN_GENERIC_ERROR =
  "Signing in with your Nostr key failed. Try again, or use your username and password above.";

/** JS is on but no NIP-07 extension answered. The legible absent-extension state. */
export const NOSTR_LOGIN_NO_SIGNER_HINT =
  "No Nostr signer found. Install a NIP-07 browser extension to sign in with your key.";

/** The signer itself rejected or never answered — not a hub error, so not a hub code. */
export const NOSTR_LOGIN_SIGNER_REFUSED =
  "Your signer didn't return a signature — the request was declined, or the extension timed out.";

/** Status line while the signer pane is open. */
export const NOSTR_LOGIN_WAITING = "Waiting for your signer…";

/** Status line between a signature and the hub's answer. */
export const NOSTR_LOGIN_VERIFYING = "Checking your signature…";

/**
 * Map a wire error code to the sentence shown beside the button.
 *
 * Falls back to the server's own `error_description` before the generic line:
 * `nostr-login.ts` writes descriptions for humans (its `invalid_event` bucket
 * is one code covering a dozen distinct reasons, and the description is the
 * only place the actual reason survives), so a description we didn't
 * anticipate is still better than a shrug.
 *
 * Exported and unit-tested because the script embeds the SAME table by
 * serializing it — one source, no drift between what the tests assert and what
 * a member reads.
 */
export function nostrLoginErrorMessage(
  code: string | null | undefined,
  description?: string | null,
): string {
  if (typeof code === "string" && Object.hasOwn(NOSTR_LOGIN_ERROR_MESSAGES, code)) {
    return NOSTR_LOGIN_ERROR_MESSAGES[code] as string;
  }
  if (typeof description === "string" && description.length > 0) return description;
  return NOSTR_LOGIN_GENERIC_ERROR;
}

/**
 * The client script's source, WITHOUT the surrounding `<script>` tags.
 *
 * Written so every global it touches — `window`, `document`, `fetch` — is a
 * free identifier. In the page those resolve to the real globals; in the tests
 * the same source is compiled with `new Function("window", "document",
 * "fetch", src)` and driven against a fake DOM and a fetch wired straight into
 * `handleNostrLogin`. That is what makes this ceremony testable at all without
 * a browser: the shipped bytes and the tested bytes are the same string.
 *
 * ES5-flavoured (`var`, `function`, promise chains) to match the other inline
 * scripts on these pre-auth pages, which are the last thing that should need a
 * transpiler.
 */
export function nostrLoginClientScript(): string {
  const table = JSON.stringify(NOSTR_LOGIN_ERROR_MESSAGES);
  const generic = JSON.stringify(NOSTR_LOGIN_GENERIC_ERROR);
  const noSigner = JSON.stringify(NOSTR_LOGIN_NO_SIGNER_HINT);
  const refused = JSON.stringify(NOSTR_LOGIN_SIGNER_REFUSED);
  const waiting = JSON.stringify(NOSTR_LOGIN_WAITING);
  const verifying = JSON.stringify(NOSTR_LOGIN_VERIFYING);
  return `
(function () {
  var block = document.getElementById(${JSON.stringify(NOSTR_LOGIN_SECTION_ID)});
  var btn = document.getElementById(${JSON.stringify(NOSTR_LOGIN_BUTTON_ID)});
  var status = document.getElementById(${JSON.stringify(NOSTR_LOGIN_STATUS_ID)});
  if (!block || !btn || !status) return;

  var MESSAGES = ${table};
  var GENERIC = ${generic};
  var NO_SIGNER = ${noSigner};
  var REFUSED = ${refused};

  function say(text, tone) {
    status.textContent = text || "";
    if (tone) status.setAttribute("data-tone", tone);
    else status.removeAttribute("data-tone");
  }

  function messageFor(code, description) {
    if (code && Object.prototype.hasOwnProperty.call(MESSAGES, code)) return MESSAGES[code];
    if (typeof description === "string" && description) return description;
    return GENERIC;
  }

  function signer() {
    var n = window.nostr;
    return n && typeof n.signEvent === "function" ? n : null;
  }

  // The section is emitted hidden so a no-JS page is byte-for-byte today's
  // page. Reaching here means JS runs, so it is always safe to show it — the
  // only question is whether the button is live or explains itself.
  var settled = false;
  var busy = false;
  function refresh(giveUp) {
    block.removeAttribute("hidden");
    if (signer()) {
      settled = true;
      btn.disabled = false;
      say("", null);
      return true;
    }
    btn.disabled = true;
    if (giveUp) say(NO_SIGNER, "hint");
    return false;
  }
  if (!refresh(false)) {
    // Extensions inject window.nostr at different points in page life; a
    // single synchronous check would call a slow-loading signer absent.
    var tries = 0;
    var tick = function () {
      if (settled) return;
      tries += 1;
      if (refresh(tries >= 3)) return;
      if (tries < 3) window.setTimeout(tick, 400);
    };
    window.setTimeout(tick, 400);
  }

  function readJson(res) {
    return res.json().then(
      function (b) { return { res: res, body: b || {} }; },
      function () { return { res: res, body: {} }; }
    );
  }
  function doorError(body) {
    return { __door: true, code: body.error, description: body.error_description };
  }

  btn.addEventListener("click", function () {
    if (busy) return;
    var nostr = signer();
    if (!nostr) { refresh(true); return; }
    busy = true;
    btn.disabled = true;
    say(${waiting}, null);

    // Where to land after the session exists. The admin page pins this
    // server-side (its own sanitized \`next\`); the OAuth page leaves it empty
    // so we re-enter the SAME /oauth/authorize?... URL, now cookied, and the
    // consent -> code -> token leg continues untouched. Either way the server
    // re-sanitizes through safeNext, so this is a hint, not a trust boundary.
    var next = btn.getAttribute("data-next");
    if (!next) next = window.location.pathname + window.location.search;

    fetch(${JSON.stringify(CHALLENGE_PATH)}, {
      credentials: "same-origin",
      headers: { accept: "application/json" }
    })
      .then(readJson)
      .then(function (r) {
        if (!r.res.ok) throw doorError(r.body);
        var tpl = r.body.event_template;
        if (!tpl || !tpl.tags) throw doorError({});
        // Sign the template VERBATIM — never a locally reconstructed \`u\` tag
        // or statement. created_at is ours because only the signer's clock
        // can set it, and the hub allows +/- 5 minutes of skew.
        return nostr.signEvent({
          kind: tpl.kind,
          created_at: Math.floor(Date.now() / 1000),
          tags: tpl.tags,
          content: tpl.content
        });
      })
      .then(function (event) {
        say(${verifying}, null);
        return fetch(${JSON.stringify(VERIFY_PATH)}, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ event: event, next: next })
        }).then(readJson);
      })
      .then(function (r) {
        var b = r.body;
        // Both success shapes carry the destination the SERVER resolved
        // (force-change-password, the friend rewrite, or the 2FA step) — we
        // follow it rather than deciding where to go.
        if (r.res.ok && b.redirect && (b.ok === true || b.requires_2fa === true)) {
          window.location.assign(b.redirect);
          return;
        }
        throw doorError(b);
      })
      .catch(function (err) {
        busy = false;
        btn.disabled = false;
        // A rejection without our marker came from the signer itself
        // (declined, locked, timed out) — it has no hub code to translate.
        if (!err || err.__door !== true) { say(REFUSED, "error"); return; }
        say(messageFor(err.code, err.description), "error");
      });
  });
})();`;
}

export interface NostrKeyDoorProps {
  /**
   * Post-login destination, already sanitized by the caller's `safeNext`.
   * Omit on the OAuth authorize page: the script then re-enters the current
   * URL, which is the authorize request itself.
   */
  next?: string;
}

/**
 * The key-door section plus its script, ready to drop inside the login card
 * after the password form.
 *
 * Emitted `hidden` with the button `disabled` — see the module docstring for
 * the three states.
 */
export function renderNostrKeyDoor(props: NostrKeyDoorProps = {}): string {
  const nextAttr =
    typeof props.next === "string" && props.next.length > 0
      ? ` data-next="${escapeAttr(props.next)}"`
      : "";
  return `
      <section class="alt-signin" id="${NOSTR_LOGIN_SECTION_ID}" hidden>
        <p class="alt-signin-label">or</p>
        <button type="button" class="btn btn-key" id="${NOSTR_LOGIN_BUTTON_ID}"${nextAttr} disabled>
          Sign in with Nostr key
        </button>
        <p class="alt-signin-status" id="${NOSTR_LOGIN_STATUS_ID}" role="status" aria-live="polite"></p>
      </section>
      <script>${nostrLoginClientScript()}
      </script>`;
}

/**
 * Styles for the section above, appended to BOTH login pages' style blocks.
 *
 * Written palette-independently (`currentColor`, neutral rgba, `inherit`) so
 * one string works inside `admin-login-ui.ts`'s and `oauth-ui.ts`'s separate
 * `STYLES` constants and stays correct in each file's light and dark themes
 * without importing either palette.
 */
export const NOSTR_LOGIN_STYLES = `
  .alt-signin {
    margin-top: 1.35rem;
    padding-top: 1.15rem;
    border-top: 1px solid rgba(128, 128, 128, 0.22);
  }
  .alt-signin[hidden] { display: none; }
  .alt-signin-label {
    margin: 0 0 0.6rem;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    opacity: 0.55;
  }
  .btn-key {
    width: 100%;
    background: transparent;
    color: inherit;
    border: 1px solid rgba(128, 128, 128, 0.4);
  }
  .btn-key:hover:not([disabled]) {
    border-color: currentColor;
    background: rgba(128, 128, 128, 0.08);
  }
  .btn-key[disabled] { cursor: not-allowed; opacity: 0.55; }
  .alt-signin-status {
    margin: 0.6rem 0 0;
    font-size: 0.88rem;
    line-height: 1.45;
    min-height: 1.3em;
    opacity: 0.75;
  }
  .alt-signin-status[data-tone="error"] { color: #a3392b; opacity: 1; }
  @media (prefers-color-scheme: dark) {
    .alt-signin-status[data-tone="error"] { color: #e59484; }
  }
`;
