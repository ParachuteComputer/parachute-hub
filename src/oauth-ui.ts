/**
 * Branded HTML templates for the OAuth login + consent + error screens.
 *
 * Pulled out of `oauth-handlers.ts` so the handlers stay focused on protocol
 * logic and the templates stay focused on presentation. Pure functions —
 * no DB access, no side channels.
 *
 * Design choices:
 *   - **No external font CDN.** OAuth screens see who's logging in and what
 *     they're authorizing; loading fonts from Google would leak that to a
 *     third party. We use system-font fallbacks that approximate the
 *     parachute.computer brand (Instrument Serif → Georgia for headings,
 *     DM Sans → -apple-system for body, ui-monospace for `<code>`).
 *   - **Inline CSS in `<style>`.** Single-file delivery; no extra round-trip
 *     for a stylesheet, no caching headaches when the hub is bound to a
 *     loopback origin.
 *   - **Scope explanations come from `scope-explanations.ts`.** First-party
 *     scopes get a one-sentence operator-facing label; admin scopes get a
 *     red border so the operator looks twice. Unknown scopes (third-party
 *     module scopes that the hub doesn't know about) render verbatim.
 *   - **No JavaScript.** Entirely form-based. Submit is the only interaction.
 */
import { renderCsrfHiddenInput } from "./csrf.ts";
import { type ScopeExplanation, explainScope } from "./scope-explanations.ts";

/** Brand palette — kept in sync with parachute.computer/style.css. */
const PALETTE = {
  bg: "#faf8f4",
  bgSoft: "#f3f0ea",
  fg: "#2c2a26",
  fgMuted: "#6b6860",
  fgDim: "#9a9690",
  accent: "#4a7c59",
  accentHover: "#3d6849",
  accentSoft: "rgba(74, 124, 89, 0.08)",
  border: "#e4e0d8",
  borderLight: "#ece9e2",
  cardBg: "#ffffff",
  danger: "#a3392b",
  dangerSoft: "rgba(163, 57, 43, 0.08)",
} as const;

const FONT_SERIF = `Georgia, "Times New Roman", serif`;
const FONT_SANS = `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
const FONT_MONO = `ui-monospace, "SF Mono", Menlo, Monaco, "Cascadia Mono", monospace`;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface AuthorizeFormParams {
  clientId: string;
  redirectUri: string;
  responseType: string;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string | null;
}

export interface LoginViewProps {
  params: AuthorizeFormParams;
  errorMessage?: string;
  csrfToken: string;
}

export interface ConsentViewProps {
  params: AuthorizeFormParams;
  clientName: string;
  clientId: string;
  scopes: string[];
  csrfToken: string;
  /**
   * Set when the request includes one or more unnamed `vault:<verb>` scopes.
   * The consent screen renders a vault selector; on submit, the picked vault
   * narrows every unnamed scope to `vault:<picked>:<verb>` (Q1 of the
   * vault-config-and-scopes design — force the picker, don't default).
   */
  vaultPicker?: VaultPicker;
  /**
   * Named-vault display: substitute unnamed `vault:<verb>` rows with
   * `vault:<displayVault>:<verb>` in the rendered scope list so the user
   * sees the scope shape that will actually be minted into the token. The
   * raw `scopes` value still drives the form-roundtrip; this only changes
   * what the operator reads.
   *
   * - Non-admin user (assigned_vault set): pass the assigned vault name so
   *   the row reads `vault:my-vault:read`.
   * - Admin user with a single vault available + the picker pre-checks the
   *   first option: pass that name so the displayed scope matches what the
   *   default-Approve will mint.
   * - Admin user with multiple vaults / no obvious default: pass `null` (or
   *   omit) and the row renders as `vault:<TBD>:read` with a tooltip
   *   pointing at the picker. Same explanation either way.
   *
   * Closes the "raw scope display" leg of the approval-UX bug — silent
   * narrowing at mint surprised operators who thought they were granting
   * vault-wide access. Now they see the named form on the consent screen
   * itself.
   */
  displayVault?: string | null;
}

export interface VaultPicker {
  /** Verbs (`read`, `write`, `admin`) requested in unnamed shape. */
  unnamedVerbs: string[];
  /** Vault names registered on this host. Empty → caller can't approve. */
  availableVaults: string[];
  /**
   * Multi-user Phase 1 (design 2026-05-20-multi-user-phase-1.md, decision-pin
   * "consent picker for non-admin users"): set when the signed-in user has a
   * non-null `assigned_vault`. The picker renders the vault name as a
   * read-only label with an admin-managed note instead of the free dropdown
   * — the user can't choose a different vault. The form still POSTs the
   * locked value via `vault_pick` so the server-side defense in
   * `handleConsentSubmit` (which refuses mints whose picked vault disagrees
   * with the user's `assigned_vault`) sees an unambiguous value.
   *
   * Admin users (assigned_vault === null) leave this undefined and see the
   * full dropdown — existing behavior.
   */
  lockedVault?: string;
}

export interface ErrorViewProps {
  title: string;
  message: string;
  status: number;
}

/**
 * Props for the "App not yet approved" view rendered when an unapproved
 * client lands on `/oauth/authorize`. Two-branch UI:
 *
 *   - Authenticated admin (operator session present + same-origin) — render
 *     the inline approve form (closes #208). One click flips the client to
 *     `approved` and re-enters the OAuth flow at consent.
 *   - Unauthenticated viewer — render TWO CTAs (no terminal mention):
 *       1. Primary: "Sign in as admin to approve" → links to
 *          `/login?next=/admin/approve-client/<client_id>` so the admin
 *          lands directly on the approval page after sign-in.
 *       2. Secondary: a fully-qualified shareable deep link to
 *          `<hub_origin>/admin/approve-client/<client_id>` with a copy
 *          button — the operator can send it to whoever runs the hub.
 *
 *   The CLI fallback (`parachute auth approve-client <id>`) was retired —
 *   the web path is the path now. Operators who want the CLI still have it
 *   in the shell; we no longer point new users there from the browser.
 */
export interface ApprovePendingViewProps {
  /** Display name to show — falls back to client_id when no name was supplied at DCR. */
  clientName: string;
  clientId: string;
  redirectUris: string[];
  /** Scopes parsed from the original `/oauth/authorize?scope=` query param. */
  requestedScopes: string[];
  /**
   * Vault hint from the original `/oauth/authorize?vault=<name>` query param,
   * passed by Notes' VaultPopover (notes#115) when kicking the OAuth flow for
   * a specific vault. Rendered alongside scopes so the operator can tell
   * which vault they're approving access for on a multi-vault hub (closes
   * #244). Single-vault hubs leave this absent and the section omits.
   */
  requestedVault?: string;
  /**
   * Fully-qualified hub origin used to build the shareable approval
   * deep-link in the unauthenticated branch. Required because the link
   * the operator copies needs to work when opened in a different browser
   * session — only the absolute URL gets that.
   */
  hubOrigin: string;
  /**
   * When set, render the inline approve form. The form posts to
   * `/oauth/authorize/approve` with the CSRF token + a `return_to` URL the
   * server will redirect to after the approve commits — the original
   * `/oauth/authorize?...` URL so the OAuth flow re-enters with the now-
   * approved client and lands on the consent screen.
   */
  approveForm?: {
    csrfToken: string;
    returnTo: string;
  };
}

export function renderLogin(props: LoginViewProps): string {
  const { params, errorMessage, csrfToken } = props;
  const error = errorMessage ? `<p class="error-banner">${escapeHtml(errorMessage)}</p>` : "";
  const body = `
    <div class="card">
      <div class="card-header">
        <div class="brand">
          <span class="brand-mark">⌬</span>
          <span class="brand-name">Parachute</span>
        </div>
        <h1>Sign in</h1>
        <p class="subtitle">to continue to your hub</p>
      </div>
      ${error}
      <form method="POST" action="/oauth/authorize" class="auth-form">
        <input type="hidden" name="__action" value="login" />
        ${renderCsrfHiddenInput(csrfToken)}
        ${renderHiddenInputs(params)}
        <label class="field">
          <span class="field-label">Username</span>
          <input type="text" name="username" autocomplete="username" autofocus required />
        </label>
        <label class="field">
          <span class="field-label">Password</span>
          <input type="password" name="password" autocomplete="current-password" required />
        </label>
        <button type="submit" class="btn btn-primary">Sign in</button>
      </form>
    </div>`;
  return baseDocument("Sign in to Parachute Hub", body);
}

export function renderConsent(props: ConsentViewProps): string {
  const { params, clientName, clientId, scopes, vaultPicker, csrfToken, displayVault } = props;
  // Substitute unnamed `vault:<verb>` rows with the resolved named form so
  // the operator sees the scope shape that will appear in the token. Raw
  // `scopes` keeps the wire form for the hidden form fields; only what's
  // rendered changes. See `ConsentViewProps.displayVault`.
  const displayedScopes = scopes.map((s) => substituteVaultDisplay(s, displayVault));
  const scopeRows =
    displayedScopes.length === 0
      ? `<li class="scope scope-empty">No scopes requested — the app gets a session token only.</li>`
      : displayedScopes.map(renderScopeRow).join("\n");
  const pickerSection = vaultPicker ? renderVaultPicker(vaultPicker) : "";
  // Approve is disabled when the picker can't yield a valid vault. The
  // empty-vault branch (no vaults registered) is the original case. A
  // locked-vault picker (multi-user Phase 1) always has a valid value via
  // the hidden input, so Approve stays enabled.
  const approveDisabled =
    vaultPicker && vaultPicker.lockedVault === undefined && vaultPicker.availableVaults.length === 0
      ? " disabled"
      : "";
  const body = `
    <div class="card">
      <div class="card-header">
        <div class="brand">
          <span class="brand-mark">⌬</span>
          <span class="brand-name">Parachute</span>
        </div>
        <h1>Authorize <span class="client-name">${escapeHtml(clientName)}</span>?</h1>
        <p class="subtitle">
          This app is requesting access to your Parachute account.
        </p>
        <p class="client-meta">
          <span class="client-meta-label">client_id</span>
          <code>${escapeHtml(clientId)}</code>
        </p>
      </div>
      <section class="scopes">
        <h2 class="scopes-title">Permissions requested</h2>
        <ul class="scope-list">${scopeRows}</ul>
      </section>
      <form method="POST" action="/oauth/authorize" class="auth-form consent-form">
        <input type="hidden" name="__action" value="consent" />
        ${renderCsrfHiddenInput(csrfToken)}
        ${renderHiddenInputs(params)}
        ${pickerSection}
        <div class="button-row">
          <button type="submit" name="approve" value="yes" class="btn btn-primary"${approveDisabled}>Approve</button>
          <button type="submit" name="approve" value="no" class="btn btn-secondary">Deny</button>
        </div>
      </form>
    </div>`;
  return baseDocument(`Authorize ${clientName}`, body);
}

function renderVaultPicker(picker: VaultPicker): string {
  const verbList = picker.unnamedVerbs.map((v) => `<code>vault:${escapeHtml(v)}</code>`).join(", ");

  // Multi-user Phase 1: non-admin users see the picker locked to their
  // `assigned_vault`. The form still posts via `vault_pick` so the
  // server-side defense in `handleConsentSubmit` sees the value — but the
  // user can't change it through the UI. A small `<input type=hidden>` and
  // a read-only label is the smallest diff that ships the lock without
  // disabling the broader form flow (Approve / Deny still work).
  if (picker.lockedVault !== undefined) {
    const locked = escapeHtml(picker.lockedVault);
    return `
        <section class="vault-picker vault-picker-locked">
          <h2 class="scopes-title">Vault</h2>
          <p class="picker-help">
            ${verbList} apply to your assigned vault.
          </p>
          <div class="vault-locked-row">
            <code class="vault-locked-name">${locked}</code>
            <span class="vault-locked-badge">Assigned</span>
          </div>
          <p class="vault-locked-note">
            Assigned vault — admin-managed; you can't change this here.
          </p>
          <input type="hidden" name="vault_pick" value="${locked}" />
        </section>`;
  }

  if (picker.availableVaults.length === 0) {
    return `
        <section class="vault-picker vault-picker-empty">
          <h2 class="scopes-title">Pick a vault</h2>
          <p class="picker-help">
            ${verbList} need to be bound to a specific vault, but no vaults exist on this host yet.
            Create one with <code>parachute-vault create &lt;name&gt;</code> and try again.
          </p>
        </section>`;
  }
  const options = picker.availableVaults
    .map(
      (name, i) => `
            <label class="vault-option">
              <input type="radio" name="vault_pick" value="${escapeHtml(name)}"${i === 0 ? " checked" : ""} required />
              <span class="vault-option-name"><code>${escapeHtml(name)}</code></span>
            </label>`,
    )
    .join("");
  return `
        <section class="vault-picker">
          <h2 class="scopes-title">Pick a vault</h2>
          <p class="picker-help">
            ${verbList} apply to the vault you select below.
          </p>
          <div class="vault-options">${options}
          </div>
        </section>`;
}

/**
 * "App not yet approved" page (#74). Two branches:
 *
 *   - **Authenticated operator with same-origin posture** (#208): render the
 *     inline approve form so one click flips the client to `approved` and
 *     re-enters the OAuth flow at consent.
 *   - **Unauthenticated viewer** (Issue 1 in the approval-UX PR): render a
 *     primary "Sign in as admin to approve" CTA wired to
 *     `/login?next=/admin/approve-client/<id>` so the admin lands directly
 *     on the approval page after sign-in, plus a secondary shareable
 *     deep-link section (fully-qualified `<hub_origin>/admin/approve-client/<id>`
 *     in a code block + Copy-to-clipboard button). The pre-rc.19 CLI hint
 *     ("ask the operator to run `parachute auth approve-client <id>`") was
 *     retired — the web path is the path now. CLI is still available for
 *     terminal-first operators who already know it; we just stop pointing
 *     new users there from a browser they're already in.
 */
export function renderApprovePending(props: ApprovePendingViewProps): string {
  const {
    clientName,
    clientId,
    redirectUris,
    requestedScopes,
    requestedVault,
    hubOrigin,
    approveForm,
  } = props;
  const redirectList = redirectUris.map((u) => `<li><code>${escapeHtml(u)}</code></li>`).join("");
  // Substitute unnamed `vault:<verb>` rows with the wildcard display form
  // (`vault:*:<verb>`) so the operator sees the shape that will appear in
  // the token after consent narrows the scope to a specific vault. At
  // approve time no vault has been picked yet — the SPA's
  // `/admin/approve-client/<id>` view uses the same wildcard treatment
  // (see `resolveScopeForDisplay` in `web/ui/src/routes/ApproveClient.tsx`).
  const displayedScopes = requestedScopes.map((s) => substituteVaultDisplay(s, "*"));
  const scopeRows =
    displayedScopes.length === 0
      ? `<li class="scope scope-empty">No scopes requested — the app gets a session token only.</li>`
      : displayedScopes.map(renderScopeRow).join("\n");
  // Wildcard explanation: surface the "the asterisk means the vault is
  // picked later" hint below the scope list when at least one row carries
  // `vault:*:<verb>`. Mirrors the SPA's inline note on
  // `/admin/approve-client/<id>`. Omitted when no scope renders with `*`
  // (all scopes are either non-vault or already-named).
  const wildcardNote = displayedScopes.some((s) => /^vault:\*:(read|write)$/.test(s))
    ? `
        <p class="scope-wildcard-note">
          <code>*</code> — a specific vault is selected during sign-in via the consent
          picker (or the user's assigned vault for multi-user setups). The
          <code>*</code> shows the unbound shape.
        </p>`
    : "";
  // Vault hint (closes #244): Notes' VaultPopover (notes#115) passes
  // `vault=<name>` on `/oauth/authorize` for per-vault grants. Surface it
  // alongside scopes so a multi-vault operator can tell which vault they're
  // approving for. Missing on single-vault hubs / pre-vault-popover clients —
  // section omits when absent.
  const vaultRow = requestedVault
    ? `
        <p class="approve-meta-row">
          <span class="approve-meta-label">vault</span>
          <code class="approve-meta-value">${escapeHtml(requestedVault)}</code>
        </p>`
    : "";
  const formSection = approveForm
    ? `
      <form method="POST" action="/oauth/authorize/approve" class="auth-form approve-form">
        ${renderCsrfHiddenInput(approveForm.csrfToken)}
        <input type="hidden" name="client_id" value="${escapeHtml(clientId)}" />
        <input type="hidden" name="return_to" value="${escapeHtml(approveForm.returnTo)}" />
        <button type="submit" class="btn btn-primary">Approve and continue</button>
      </form>`
    : renderUnauthenticatedApproveCtas(hubOrigin, clientId);
  const body = `
    <div class="card">
      <div class="card-header">
        <div class="brand">
          <span class="brand-mark">⌬</span>
          <span class="brand-name">Parachute</span>
        </div>
        <h1>App not yet approved</h1>
        <p class="subtitle">
          ${escapeHtml(clientName)} is registered with this hub but hasn't been approved yet.
          Review the details below before approving.
        </p>
      </div>
      <section class="approve-meta">
        <h2 class="scopes-title">Application</h2>
        <p class="approve-meta-row">
          <span class="approve-meta-label">name</span>
          <code class="approve-meta-value">${escapeHtml(clientName)}</code>
        </p>
        <p class="approve-meta-row">
          <span class="approve-meta-label">client_id</span>
          <code class="approve-meta-value">${escapeHtml(clientId)}</code>
        </p>${vaultRow}
        <div class="approve-meta-row approve-meta-row-block">
          <span class="approve-meta-label">redirect_uris</span>
          <ul class="approve-redirect-list">${redirectList}</ul>
        </div>
      </section>
      <section class="scopes">
        <h2 class="scopes-title">Permissions requested</h2>
        <ul class="scope-list">${scopeRows}</ul>${wildcardNote}
      </section>
      ${formSection}
    </div>`;
  return baseDocument("App not yet approved", body);
}

/**
 * Unauthenticated branch of `renderApprovePending`. Two CTAs:
 *
 *   1. Primary: "Sign in as admin to approve" → links to
 *      `/login?next=/admin/approve-client/<client_id>` so the admin lands
 *      on the approval page after sign-in.
 *   2. Secondary: a fully-qualified shareable deep-link to
 *      `<hub_origin>/admin/approve-client/<client_id>` with a Copy button
 *      so the operator can send it to whoever runs the hub.
 *
 * Inline JS is scoped to the Copy button only — `navigator.clipboard.writeText`
 * with a brief "Copied!" affordance. The button degrades gracefully when
 * scripting is unavailable (the URL is still selectable + copyable from the
 * `<code>` block via the OS clipboard).
 */
function renderUnauthenticatedApproveCtas(hubOrigin: string, clientId: string): string {
  const approvalPath = `/admin/approve-client/${encodeURIComponent(clientId)}`;
  const loginHref = `/login?next=${encodeURIComponent(approvalPath)}`;
  const trimmedOrigin = hubOrigin.replace(/\/+$/, "");
  const deepLink = `${trimmedOrigin}${approvalPath}`;
  return `
      <div class="approve-actions">
        <a href="${escapeHtml(loginHref)}" class="btn btn-primary approve-signin-cta">
          Sign in as admin to approve
        </a>
      </div>
      <section class="approve-share">
        <h2 class="scopes-title">Or send this link to your hub admin</h2>
        <p class="approve-share-help">
          Anyone with admin access on this hub can open the link below to approve the app.
        </p>
        <div class="approve-share-row">
          <code class="approve-share-link" id="approve-share-link">${escapeHtml(deepLink)}</code>
          <button
            type="button"
            class="btn btn-secondary approve-share-copy"
            id="approve-share-copy"
            data-link="${escapeHtml(deepLink)}"
          >Copy link</button>
        </div>
      </section>
      <script>
        (function () {
          var btn = document.getElementById('approve-share-copy');
          if (!btn) return;
          var defaultLabel = btn.textContent;
          btn.addEventListener('click', function () {
            var link = btn.dataset.link || '';
            var done = function (ok) {
              btn.textContent = ok ? 'Copied!' : 'Copy failed';
              setTimeout(function () { btn.textContent = defaultLabel; }, 1600);
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(link).then(function () { done(true); }, function () { done(false); });
            } else {
              // Fallback for browsers without async clipboard (older Safari,
              // sandboxed iframes). Select the code block so the user can
              // hit cmd/ctrl-C to copy manually.
              try {
                var range = document.createRange();
                range.selectNode(document.getElementById('approve-share-link'));
                var sel = window.getSelection();
                if (sel) { sel.removeAllRanges(); sel.addRange(range); }
                done(true);
              } catch (e) {
                done(false);
              }
            }
          });
        })();
      </script>`;
}

/**
 * Substitute an unnamed `vault:<verb>` scope with the resolved named form
 * (`vault:<displayVault>:<verb>`) so consent / approval screens render
 * what'll actually appear in the token rather than the raw OAuth request.
 *
 *   - `displayVault === undefined` → no substitution (keep input as-is).
 *     Use this when the caller doesn't know what vault will be picked yet
 *     and prefers the raw OAuth form. (Currently unused; reserved for the
 *     pre-narrowing approve flow where the vault isn't known until consent.)
 *   - `displayVault === null` → render with a `<TBD>` placeholder. Used on
 *     the admin consent screen when the picker hasn't been touched yet, and
 *     on the operator approval page where the vault is selected at the
 *     per-user sign-in step, not at approve time.
 *   - `displayVault === "*"` → render with a literal asterisk placeholder
 *     (`vault:*:verb`). Used on the server-rendered approve-pending page
 *     and the SPA's `/admin/approve-client/<id>` view: at approve time the
 *     vault isn't bound yet (no consent picker has run), so the asterisk
 *     signals "wildcard — a specific vault is selected later in the flow."
 *     Callers that render this form should also surface the inline
 *     explanation below the scope list (see `renderApprovePending`).
 *   - `displayVault === "name"` → render as `vault:name:verb` literally.
 *
 * Non-vault scopes pass through untouched. Already-named `vault:<x>:<verb>`
 * scopes also pass through — the OAuth request already specified a vault,
 * so there's nothing to resolve.
 */
export function substituteVaultDisplay(
  scope: string,
  displayVault: string | null | undefined,
): string {
  if (displayVault === undefined) return scope;
  const parts = scope.split(":");
  if (parts.length !== 2 || parts[0] !== "vault") return scope;
  const verb = parts[1];
  if (verb !== "read" && verb !== "write") return scope;
  const vaultLabel = displayVault === null ? "<TBD>" : displayVault;
  return `vault:${vaultLabel}:${verb}`;
}

export function renderError(props: ErrorViewProps): string {
  const body = `
    <div class="card">
      <div class="card-header">
        <div class="brand">
          <span class="brand-mark">⌬</span>
          <span class="brand-name">Parachute</span>
        </div>
        <h1 class="error-title">${escapeHtml(props.title)}</h1>
        <p class="subtitle">${escapeHtml(props.message)}</p>
      </div>
      <p class="error-help">
        If you reached this from a third-party app, the app's OAuth configuration
        may be wrong. You can safely close this window.
      </p>
    </div>`;
  return baseDocument(props.title, body);
}

export interface UnknownClientViewProps {
  /** The unknown client_id the request carried. Surfaced verbatim for debugging. */
  clientId: string;
  /**
   * The redirect_uri the request carried, when present + parseable as
   * `<one-of-our-bound-origins>/<path>`. Triggers the inline "Reset
   * connection" affordance: the page emits a tiny JS snippet that clears
   * the requesting SPA's DCR localStorage cache (any key prefixed
   * `lens:dcr:`) on our own origin, then navigates to the redirect_uri's
   * mount path so the SPA picks up a fresh DCR.
   *
   * Set to `null` when the redirect_uri is missing, malformed, or points
   * at an origin we don't serve — those reach a third-party SPA we can't
   * safely interact with from our DOM and we fall back to the static
   * error variant.
   */
  selfOriginRedirectPath: string | null;
}

/**
 * "Unknown application" page rendered when `/oauth/authorize` receives a
 * `client_id` that's not in the hub's `clients` table. The single most-
 * reported cause is a stale localStorage entry on the SPA side: the
 * operator wiped `~/.parachute/hub.db` between testing iterations, but the
 * browser still holds the old hub's DCR-cached client_id and keeps using
 * it. The hub's behaviour is correct (reject unknown client_id, never
 * grant an authorize request against an unregistered client) but the
 * operator is stranded — they need to clear the SPA's cache and the SPA
 * has no signal to do that on its own.
 *
 * Recovery affordance: when the redirect_uri points at an origin the hub
 * itself serves (any entry in `hubBoundOrigins`), the page renders a
 * "Reset connection" button. The button runs an inline JS snippet that
 * clears every `lens:dcr:*` key from localStorage on the hub's own origin
 * — since Notes (and any future Parachute SPA) is mounted at the hub's
 * origin, they share localStorage with this error page — then navigates
 * back to the redirect_uri's mount path. The SPA loads fresh, finds no
 * cached client_id, and runs a brand-new DCR against the current hub.
 *
 * `lens:dcr:` is intentionally hardcoded: Notes' storage layer uses that
 * prefix (see `parachute-notes/src/lib/vault/storage.ts`'s `DCR_PREFIX`).
 * Future SPAs that follow the same hub-origin-mounted shape would need
 * their prefix added here, or we extend the snippet to clear any key
 * matching `.*:dcr:.*`. Today it's just Notes.
 *
 * No JS used outside the optional reset button — the static parts stay
 * form-free + accessible to readers/screen-readers without script.
 */
export function renderUnknownClient(props: UnknownClientViewProps): string {
  const safeClientId = escapeHtml(props.clientId);
  const resetSection =
    props.selfOriginRedirectPath !== null
      ? `
      <p>Most often this means the app's local connection state was saved
        against a previous installation of this hub. Resetting the
        connection clears the stale state and lets the app register
        afresh.</p>
      <div class="unknown-client-actions">
        <button type="button" class="btn btn-primary" id="unknown-client-reset"
          data-target="${escapeHtml(props.selfOriginRedirectPath)}">Reset connection &amp; reload</button>
      </div>
      <p class="fine">If the button doesn't help, clear site data for this
        hub in your browser and reload the app.</p>
      <script>
        (function () {
          var btn = document.getElementById('unknown-client-reset');
          if (!btn) return;
          btn.addEventListener('click', function () {
            try {
              // Notes (and other Parachute SPAs mounted at this hub's
              // origin) cache DCR client_ids under the 'lens:dcr:' key
              // prefix. Clear them all — a stale entry against a wiped
              // hub.db is the canonical cause of this error.
              var keys = [];
              for (var i = 0; i < localStorage.length; i++) {
                var k = localStorage.key(i);
                if (k && k.indexOf('lens:dcr:') === 0) keys.push(k);
              }
              keys.forEach(function (k) { localStorage.removeItem(k); });
            } catch (e) {
              // localStorage may be unavailable (private mode, sandbox).
              // The redirect still happens — the SPA will try DCR again
              // and either succeed or surface its own diagnostic.
            }
            var target = btn.dataset.target || '/';
            window.location.assign(target);
          });
        })();
      </script>`
      : `
      <p class="error-help">
        If you reached this from a third-party app, the app's OAuth
        configuration may be wrong. You can safely close this window.
      </p>`;
  const body = `
    <div class="card">
      <div class="card-header">
        <div class="brand">
          <span class="brand-mark">⌬</span>
          <span class="brand-name">Parachute</span>
        </div>
        <h1 class="error-title">Unknown application</h1>
        <p class="subtitle">
          This <code>client_id</code> is not registered with this hub:
          <code>${safeClientId}</code>.
        </p>
      </div>
      ${resetSection}
    </div>`;
  return baseDocument("Unknown application", body);
}

function renderScopeRow(scope: string): string {
  // Special-case the `<TBD>` placeholder substituted by `substituteVaultDisplay`
  // when the consent picker hasn't bound a vault yet — `explainScope` doesn't
  // match it because `<` / `>` aren't in the vault-name charset, but the
  // canonical verb-form does. Look up by the unnamed verb form so the
  // explanation + level styling are still correct.
  const tbdMatch = scope.match(/^vault:<TBD>:(read|write)$/);
  const lookup = tbdMatch ? `vault:${tbdMatch[1]}` : scope;
  const explanation = explainScope(lookup);
  if (!explanation) {
    return `<li class="scope scope-unknown">
      <code class="scope-name">${escapeHtml(scope)}</code>
      <span class="scope-label scope-label-muted">Defined by the requesting app — no built-in description.</span>
    </li>`;
  }
  const cls = `scope scope-${explanation.level}`;
  const badge = badgeForLevel(explanation);
  // Pending-vault hint surfaces the silent-narrowing semantics for admin
  // operators who land on the consent screen before touching the picker.
  // Once they pick, the form submission narrows the scope to the chosen
  // vault — the rendered placeholder reflects that the vault is still
  // open at this moment in the flow.
  const pendingNote = tbdMatch
    ? `<span class="scope-pending-note">A specific vault is picked below before approving.</span>`
    : "";
  return `<li class="${cls}">
      <div class="scope-head">
        <code class="scope-name">${escapeHtml(scope)}</code>
        ${badge}
      </div>
      <span class="scope-label">${escapeHtml(explanation.label)}</span>
      ${pendingNote}
    </li>`;
}

function badgeForLevel(explanation: ScopeExplanation): string {
  switch (explanation.level) {
    case "admin":
      return `<span class="badge badge-admin">admin</span>`;
    case "write":
      return `<span class="badge badge-write">write</span>`;
    case "send":
      return `<span class="badge badge-send">send</span>`;
    case "read":
      return `<span class="badge badge-read">read</span>`;
  }
}

export function renderHiddenInputs(p: AuthorizeFormParams): string {
  const fields: [string, string][] = [
    ["client_id", p.clientId],
    ["redirect_uri", p.redirectUri],
    ["response_type", p.responseType],
    ["scope", p.scope],
    ["code_challenge", p.codeChallenge],
    ["code_challenge_method", p.codeChallengeMethod],
  ];
  if (p.state) fields.push(["state", p.state]);
  return fields
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}" />`)
    .join("\n        ");
}

function baseDocument(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="referrer" content="no-referrer" />
  <style>${STYLES}</style>
</head>
<body>
  <main>
${body}
  </main>
</body>
</html>`;
}

const STYLES = `
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: ${FONT_SANS};
    background: ${PALETTE.bg};
    color: ${PALETTE.fg};
    line-height: 1.55;
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
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
    background: ${PALETTE.cardBg};
    border: 1px solid ${PALETTE.border};
    border-radius: 12px;
    padding: 2rem 1.75rem;
    box-shadow: 0 1px 2px rgba(44, 42, 38, 0.04), 0 8px 24px rgba(44, 42, 38, 0.06);
  }
  .card-header { margin-bottom: 1.5rem; }
  .brand {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: ${PALETTE.accent};
    font-weight: 500;
    font-size: 0.95rem;
    margin-bottom: 1.25rem;
  }
  .brand-mark { font-size: 1.1rem; line-height: 1; }
  .brand-name { letter-spacing: 0.01em; }
  h1 {
    font-family: ${FONT_SERIF};
    font-weight: 400;
    font-size: 1.75rem;
    line-height: 1.2;
    margin: 0 0 0.4rem;
    color: ${PALETTE.fg};
  }
  h1 .client-name {
    font-style: italic;
    color: ${PALETTE.accent};
  }
  .subtitle {
    margin: 0;
    color: ${PALETTE.fgMuted};
    font-size: 0.95rem;
  }
  .client-meta {
    margin: 0.75rem 0 0;
    font-size: 0.8rem;
    color: ${PALETTE.fgDim};
    display: flex;
    gap: 0.4rem;
    align-items: baseline;
    flex-wrap: wrap;
  }
  .client-meta-label { text-transform: uppercase; letter-spacing: 0.05em; }
  .client-meta code {
    font-family: ${FONT_MONO};
    font-size: 0.78rem;
    background: ${PALETTE.bgSoft};
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    color: ${PALETTE.fgMuted};
    word-break: break-all;
  }

  .auth-form { display: flex; flex-direction: column; gap: 0.9rem; }
  .field { display: flex; flex-direction: column; gap: 0.35rem; }
  .field-label {
    font-size: 0.85rem;
    font-weight: 500;
    color: ${PALETTE.fgMuted};
    letter-spacing: 0.01em;
  }
  input[type=text], input[type=password] {
    font: inherit;
    width: 100%;
    padding: 0.6rem 0.75rem;
    border: 1px solid ${PALETTE.border};
    border-radius: 6px;
    background: ${PALETTE.bg};
    color: ${PALETTE.fg};
    transition: border-color 0.15s ease, background 0.15s ease;
  }
  input[type=text]:focus, input[type=password]:focus {
    outline: none;
    border-color: ${PALETTE.accent};
    background: ${PALETTE.cardBg};
    box-shadow: 0 0 0 3px ${PALETTE.accentSoft};
  }

  .btn {
    font: inherit;
    font-weight: 500;
    padding: 0.65rem 1.25rem;
    border-radius: 6px;
    border: 1px solid transparent;
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
    min-height: 2.5rem;
  }
  .btn-primary {
    background: ${PALETTE.accent};
    color: ${PALETTE.cardBg};
    margin-top: 0.4rem;
  }
  .btn-primary:hover { background: ${PALETTE.accentHover}; }
  .btn-secondary {
    background: ${PALETTE.cardBg};
    color: ${PALETTE.fgMuted};
    border-color: ${PALETTE.border};
  }
  .btn-secondary:hover {
    color: ${PALETTE.fg};
    border-color: ${PALETTE.fgDim};
  }
  .button-row {
    display: flex;
    gap: 0.6rem;
    margin-top: 0.5rem;
  }
  .button-row .btn { flex: 1; }
  .consent-form { gap: 0; }

  .error-banner {
    background: ${PALETTE.dangerSoft};
    border: 1px solid ${PALETTE.danger};
    border-radius: 6px;
    color: ${PALETTE.danger};
    padding: 0.6rem 0.8rem;
    margin: 0 0 1rem;
    font-size: 0.9rem;
  }
  .error-title { color: ${PALETTE.danger}; }
  .error-help {
    margin-top: 1.5rem;
    padding-top: 1.25rem;
    border-top: 1px solid ${PALETTE.borderLight};
    color: ${PALETTE.fgMuted};
    font-size: 0.88rem;
  }
  .unknown-client-actions {
    margin: 1.25rem 0 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .fine {
    color: ${PALETTE.fgMuted};
    font-size: 0.85rem;
  }

  .scopes { margin: 0 0 1.5rem; }
  .scopes-title {
    font-family: ${FONT_SANS};
    font-size: 0.78rem;
    font-weight: 600;
    color: ${PALETTE.fgMuted};
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 0 0 0.6rem;
  }
  .scope-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .scope {
    border: 1px solid ${PALETTE.border};
    border-radius: 6px;
    padding: 0.6rem 0.75rem;
    background: ${PALETTE.bg};
  }
  .scope-empty {
    color: ${PALETTE.fgMuted};
    font-size: 0.9rem;
    background: ${PALETTE.bgSoft};
    border-style: dashed;
  }
  .scope-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.2rem;
    flex-wrap: wrap;
  }
  .scope-name {
    font-family: ${FONT_MONO};
    font-size: 0.85rem;
    color: ${PALETTE.fg};
  }
  .scope-label {
    font-size: 0.88rem;
    color: ${PALETTE.fgMuted};
    display: block;
  }
  .scope-label-muted { color: ${PALETTE.fgDim}; font-style: italic; }
  .scope-admin {
    border-color: ${PALETTE.danger};
    background: ${PALETTE.dangerSoft};
  }
  .scope-admin .scope-name { color: ${PALETTE.danger}; }

  .vault-picker {
    margin: 0 0 1.25rem;
    padding: 0.75rem 0.85rem;
    border: 1px solid ${PALETTE.borderLight};
    border-radius: 6px;
    background: ${PALETTE.bgSoft};
  }
  .vault-picker .scopes-title { margin-bottom: 0.4rem; }
  .picker-help {
    margin: 0 0 0.6rem;
    font-size: 0.88rem;
    color: ${PALETTE.fgMuted};
  }
  .picker-help code {
    font-family: ${FONT_MONO};
    font-size: 0.82rem;
    background: ${PALETTE.cardBg};
    padding: 0.05rem 0.35rem;
    border-radius: 4px;
    color: ${PALETTE.fg};
  }
  .vault-options {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .vault-option {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.45rem 0.6rem;
    border: 1px solid ${PALETTE.border};
    border-radius: 6px;
    background: ${PALETTE.cardBg};
    cursor: pointer;
    transition: border-color 0.15s ease, background 0.15s ease;
  }
  .vault-option:hover { border-color: ${PALETTE.accent}; }
  .vault-option input[type=radio]:focus { outline: 2px solid ${PALETTE.accent}; outline-offset: 2px; }
  .vault-option-name code {
    font-family: ${FONT_MONO};
    font-size: 0.88rem;
    color: ${PALETTE.fg};
  }
  .vault-picker-empty .picker-help { color: ${PALETTE.danger}; }
  .vault-picker-empty .picker-help code { color: ${PALETTE.fg}; }
  .vault-picker-locked .picker-help { color: ${PALETTE.fgMuted}; }
  .vault-locked-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.6rem;
    border: 1px solid ${PALETTE.border};
    border-radius: 6px;
    background: ${PALETTE.cardBg};
    margin: 0.25rem 0 0.5rem;
  }
  .vault-locked-name {
    font-family: ${FONT_MONO};
    font-size: 0.9rem;
    color: ${PALETTE.fg};
    flex: 1;
  }
  .vault-locked-badge {
    display: inline-block;
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    background: ${PALETTE.accentSoft};
    color: ${PALETTE.accent};
  }
  .vault-locked-note {
    margin: 0;
    font-size: 0.82rem;
    color: ${PALETTE.fgDim};
    font-style: italic;
  }

  .approve-meta {
    margin: 0 0 1.25rem;
    padding: 0.75rem 0.85rem;
    border: 1px solid ${PALETTE.borderLight};
    border-radius: 6px;
    background: ${PALETTE.bgSoft};
  }
  .approve-meta .scopes-title { margin-bottom: 0.5rem; }
  .approve-meta-row {
    margin: 0 0 0.4rem;
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    flex-wrap: wrap;
  }
  .approve-meta-row:last-child { margin-bottom: 0; }
  .approve-meta-row-block { flex-direction: column; gap: 0.25rem; }
  .approve-meta-label {
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: 0.7rem;
    color: ${PALETTE.fgDim};
  }
  .approve-meta-value {
    font-family: ${FONT_MONO};
    font-size: 0.82rem;
    background: ${PALETTE.cardBg};
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    color: ${PALETTE.fg};
    word-break: break-all;
  }
  .approve-redirect-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .approve-redirect-list li code {
    font-family: ${FONT_MONO};
    font-size: 0.82rem;
    background: ${PALETTE.cardBg};
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    color: ${PALETTE.fg};
    word-break: break-all;
  }
  .approve-form { gap: 0; }
  .approve-actions {
    margin-top: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .approve-signin-cta {
    display: inline-block;
    text-align: center;
    text-decoration: none;
    line-height: 1.4;
  }
  .approve-signin-cta:hover {
    background: ${PALETTE.accentHover};
    color: ${PALETTE.cardBg};
  }
  .approve-share {
    margin-top: 1.5rem;
    padding-top: 1.25rem;
    border-top: 1px solid ${PALETTE.borderLight};
  }
  .approve-share-help {
    margin: 0 0 0.6rem;
    color: ${PALETTE.fgMuted};
    font-size: 0.88rem;
  }
  .approve-share-row {
    display: flex;
    gap: 0.5rem;
    align-items: stretch;
    flex-wrap: wrap;
  }
  .approve-share-link {
    flex: 1;
    min-width: 0;
    font-family: ${FONT_MONO};
    font-size: 0.82rem;
    background: ${PALETTE.bgSoft};
    padding: 0.55rem 0.65rem;
    border-radius: 6px;
    color: ${PALETTE.fg};
    word-break: break-all;
    border: 1px solid ${PALETTE.border};
  }
  .approve-share-copy {
    flex-shrink: 0;
    min-height: 0;
    padding: 0.5rem 0.9rem;
    font-size: 0.85rem;
  }
  .scope-pending-note {
    display: block;
    margin-top: 0.25rem;
    font-size: 0.78rem;
    color: ${PALETTE.fgDim};
    font-style: italic;
  }
  .scope-wildcard-note {
    margin: 0.6rem 0 0;
    font-size: 0.82rem;
    color: ${PALETTE.fgDim};
    font-style: italic;
    line-height: 1.45;
  }
  .scope-wildcard-note code {
    font-family: ${FONT_MONO};
    font-style: normal;
    background: ${PALETTE.bgSoft};
    padding: 0.05rem 0.3rem;
    border-radius: 4px;
    color: ${PALETTE.fgMuted};
  }
  .badge {
    display: inline-block;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    line-height: 1.4;
  }
  .badge-read { background: ${PALETTE.bgSoft}; color: ${PALETTE.fgMuted}; }
  .badge-write { background: ${PALETTE.accentSoft}; color: ${PALETTE.accent}; }
  .badge-send { background: ${PALETTE.accentSoft}; color: ${PALETTE.accent}; }
  .badge-admin { background: ${PALETTE.danger}; color: ${PALETTE.cardBg}; }

  @media (max-width: 480px) {
    main { padding: 0.75rem; }
    .card { padding: 1.5rem 1.25rem; border-radius: 10px; }
    h1 { font-size: 1.5rem; }
    .button-row { flex-direction: column; }
  }

  @media (prefers-color-scheme: dark) {
    body { background: #1a1815; color: #e8e4dc; }
    .card { background: #25221d; border-color: #3a362f; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); }
    h1 { color: #f0ece4; }
    .subtitle, .field-label { color: #a8a29a; }
    input[type=text], input[type=password] { background: #1f1c18; border-color: #3a362f; color: #e8e4dc; }
    input[type=text]:focus, input[type=password]:focus { background: #25221d; }
    .scope { background: #1f1c18; border-color: #3a362f; }
    .scope-name { color: #e8e4dc; }
    .client-meta code { background: #1f1c18; color: #a8a29a; }
    .btn-secondary { background: #25221d; border-color: #3a362f; color: #a8a29a; }
    .btn-secondary:hover { color: #e8e4dc; border-color: #6b6860; }
    .error-help { border-color: #3a362f; color: #a8a29a; }
    .scope-empty { background: #1a1815; }
  }
`;
