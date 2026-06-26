/**
 * First-boot setup wizard at `/admin/setup` (hub#259).
 *
 * Server-rendered, three-step form that walks a fresh operator through:
 *
 *   1. Welcome — what they're about to set up (admin account + first vault).
 *   2. Account — username + password → POST `/admin/setup/account`.
 *      Creates the admin row via `createUser`, sets a `parachute_hub_session`
 *      cookie + a `parachute_hub_csrf` cookie, redirects back to
 *      `/admin/setup`.
 *   3. Vault — pick a name (default `default`) → POST `/admin/setup/vault`.
 *      Gated by the just-minted admin session cookie. Drives the same
 *      `runInstall` path the `/api/modules/:short/install` API uses, just
 *      without re-fabricating an HTTP request + bearer. Returns + redirects
 *      to `/admin/setup?op=<id>` so the same wizard page polls the
 *      operation registry.
 *   4. Done — links to the admin SPA, MCP install hints, "what's next."
 *
 * The wizard is server-rendered (no SPA bundle, no JS). Step 3's progress
 * poll is a `<meta http-equiv="refresh" content="2">` — works without JS
 * and is fine for a 30-second one-shot install on first boot.
 *
 * Idempotency: the rendered step is derived from DB + services.json on
 * every GET. If a user already exists but no vault, the wizard resumes
 * at step 3. If both exist, it resumes at step 4. Once both exist + a
 * full minute has elapsed since the user was created, subsequent GETs
 * 301 to `/login` (the canonical post-setup entry).
 *
 * No email collection (the brief). Magic-link recovery is a later phase.
 * No 2FA in this wizard either — adds it later; the launch posture is
 * "username + password is fine for a fresh hub."
 *
 * History: replaces the static placeholder `renderSetupPlaceholder` from
 * the hub#258 setup-gate scaffold. The env-var seed path
 * (`PARACHUTE_INITIAL_ADMIN_USERNAME` + `PARACHUTE_INITIAL_ADMIN_PASSWORD`)
 * still works for container operators who prefer to bake the admin into
 * the boot path; documented as an alternative on the welcome screen.
 */

import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type OperationsRegistry, runInstall, specFor } from "./api-modules-ops.ts";
import { CURATED_MODULES, type CuratedModuleShort } from "./api-modules.ts";
import {
  BOOTSTRAP_TOKEN_PREFIX,
  consumeBootstrapToken,
  getBootstrapToken,
  verifyBootstrapToken,
} from "./bootstrap-token.ts";
import { WORDMARK_TEXT, brandMarkSvg } from "./brand.ts";
import {
  CSRF_FIELD_NAME,
  ensureCsrfToken,
  renderCsrfHiddenInput,
  verifyCsrfToken,
} from "./csrf.ts";
import { type ExposeState, readExposeState } from "./expose-state.ts";
import {
  SETUP_EXPOSE_MODES,
  type SetupExposeMode,
  deleteSetting,
  getHubOrigin,
  getSetting,
  isSetupExposeMode,
  openFirstClientAutoApproveWindow,
  setSetting,
} from "./hub-settings.ts";
import { signAccessToken } from "./jwt-sign.ts";
import { escapeHtml } from "./oauth-ui.ts";
import {
  type IssueOperatorTokenResult,
  type MintOperatorTokenOpts,
  issueOperatorToken,
  readOperatorTokenFile,
} from "./operator-token.ts";
import { isHttpsRequest } from "./request-protocol.ts";
import {
  decideLocalProvider,
  platformLocalProvider,
  readAvailableRamMib,
} from "./scribe-config.ts";
import { SEED_VERSION } from "./service-spec.ts";
import { findService, readManifestLenient } from "./services-manifest.ts";
import {
  SESSION_TTL_MS,
  buildSessionCookie,
  createSession,
  findActiveSession,
} from "./sessions.ts";
import type { Supervisor } from "./supervisor.ts";
import { createUser, userCount } from "./users.ts";
import { sanitizePublicOrigin } from "./vault-hub-origin-env.ts";
import { DEFAULT_VAULT_NAME, validateVaultName } from "./vault-name.ts";

// --- shared chrome --------------------------------------------------------

const PALETTE = {
  bg: "#faf8f4",
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
  success: "#3d6849",
  warn: "#d4a017",
  warnSoft: "#fff8e1",
} as const;

const FONT_SERIF = `Georgia, "Times New Roman", serif`;
const FONT_SANS = `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
const FONT_MONO = `ui-monospace, "SF Mono", Menlo, Monaco, "Cascadia Mono", monospace`;

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * The CLI wizard (hub#168 Cut 3) sends `Accept: application/json` on
 * every GET; the browser sends `Accept: text/html, …`. We branch the GET
 * handler's response shape on this header. Same DB / state-derivation
 * path both ways — only the rendering forks.
 *
 * POSTs from the CLI wizard send `Content-Type: application/json`;
 * browser POSTs send `application/x-www-form-urlencoded`. The POST
 * handlers parse-into-the-same-shape with `readBodyFields` below.
 */
function wantsJsonResponse(req: Request): boolean {
  const accept = req.headers.get("accept") ?? "";
  return accept.includes("application/json");
}

/**
 * Best-effort body parser shared by every wizard POST handler. Branches
 * on Content-Type:
 *   * `application/json` → parses the body as JSON, projects each
 *     top-level field into a `Map<string, string>` (matches the
 *     FormData getter shape the rest of the handlers use).
 *   * Anything else → standard `req.formData()` (the historical browser
 *     path).
 *
 * Returns a tuple of `[fields, isJson]`. `isJson` lets the handler
 * decide between a 303 redirect (browser) and a 200 JSON envelope
 * (CLI). The fields-getter API is intentionally lossy on JSON arrays /
 * nested objects — every wizard field today is a plain string, so the
 * Map<string, string> shape is sufficient. If we ever need arrays here,
 * extend with a `getAll(name)` shim.
 */
async function readBodyFields(req: Request): Promise<{
  get: (name: string) => string | null;
  isJson: boolean;
}> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = (await req.json()) as Record<string, unknown>;
    } catch {
      // Malformed JSON falls through to an empty map — the handlers'
      // existing field-validation surfaces the right error message.
      parsed = {};
    }
    return {
      isJson: true,
      get: (name: string) => {
        const v = parsed[name];
        if (typeof v === "string") return v;
        if (typeof v === "number" || typeof v === "boolean") return String(v);
        return null;
      },
    };
  }
  const form = await req.formData();
  return {
    isJson: false,
    get: (name: string) => {
      const v = form.get(name);
      return typeof v === "string" ? v : null;
    },
  };
}

// --- state derivation ----------------------------------------------------

/**
 * Wizard steps. `"account"` is a visual-only entry in the progress
 * header — it shares a screen with `"welcome"` (the combined welcome +
 * account form), and `deriveWizardState` never returns it: a welcome
 * POST creates the admin and advances directly to `"vault"`. Kept in
 * the union so the progress bar can render it as a distinct dot for
 * display continuity.
 */
export type WizardStep = "welcome" | "account" | "vault" | "expose" | "done";

export interface DerivedWizardState {
  /** Current step the wizard should render. */
  step: WizardStep;
  /** Whether at least one user row exists. */
  hasAdmin: boolean;
  /** Whether the first vault (curated) has been provisioned in services.json. */
  hasVault: boolean;
  /**
   * Whether a REAL vault instance exists (a non-placeholder services.json
   * row) — `hasVault` minus the `setup_vault_skipped` marker. The
   * re-enterable vault step (B5, 2026-06-09 hub-module-boundary) keys on
   * this: an operator who skipped the wizard's vault step has
   * `hasVault === true` but `hasRealVault === false`, and the
   * `/admin/setup?step=vault` deep-link (Home's "create your first vault"
   * card) must still reach the create/import form.
   */
  hasRealVault: boolean;
  /**
   * Whether the operator has answered the "how will this hub be reached?"
   * question (the expose step, hub#268 Item 2). When admin + vault both
   * exist but the operator hasn't picked an expose mode yet, the wizard
   * renders the expose step rather than the done screen.
   */
  hasExposeMode: boolean;
}

/**
 * Vault is the canonical first-vault target for the wizard. The brief
 * specifies "first vault — pick a name (default: `default`)" and the
 * curated module list is what install / supervisor speak.
 */
export const FIRST_VAULT_SHORT: CuratedModuleShort = "vault";

/**
 * Map a live exposure layer (`expose-state.json`) onto the wizard's
 * `setup_expose_mode`. The two enums overlap exactly on the layers the
 * exposure file can carry: `ExposeLayer` is `tailnet | public`, both of
 * which are valid `SetupExposeMode` values. (There's no `localhost`
 * exposure layer — running nothing is the absence of a state file, which
 * `readExposeState` reports as `undefined`, so a missing/unexposed hub
 * never seeds and the wizard still asks.)
 *
 * Returns `undefined` when no exposure is live (or the reader throws on
 * a malformed file — we swallow that and fall through to "still ask"
 * rather than crashing the wizard GET).
 */
function exposeModeFromLiveState(read: () => ExposeState | undefined): SetupExposeMode | undefined {
  let state: ExposeState | undefined;
  try {
    state = read();
  } catch {
    // A corrupt expose-state.json shouldn't brick the wizard. Treat it
    // as "no live exposure" and let the operator answer the step.
    return undefined;
  }
  if (!state) return undefined;
  // `ExposeLayer` ⊆ `SetupExposeMode` ("tailnet" | "public").
  return state.layer;
}

/**
 * Read DB + services.json to decide which step the wizard should render.
 * Idempotent — re-running after partial setup picks up where it left
 * off. Mostly read-only, with one specific write: on Render (or any
 * platform `detectAutoExposeMode` recognizes), OR when a live tailscale
 * exposure (`expose-state.json`) is already up, the first call auto-
 * seeds `setup_expose_mode` so the wizard skips the expose step.
 * Subsequent calls find the setting present and are read-only.
 */
export function deriveWizardState(deps: {
  db: Database;
  manifestPath: string;
  /**
   * Optional env-override. When undefined, falls through to `process.env`.
   * Used by tests + by handleSetupGet which threads through the full
   * SetupWizardDeps.env.
   */
  env?: Record<string, string | undefined>;
  /**
   * Optional injected reader for the live exposure state
   * (`~/.parachute/expose-state.json`). Defaults to the real
   * `readExposeState`. Mirrors the `init.ts` seam (`readExposeStateFn`)
   * so tests can drive the "a tailnet layer is already live" branch
   * without writing a real state file. When `setup_expose_mode` is
   * unset, the live exposure layer auto-seeds the setting (see below).
   */
  readExposeStateFn?: () => ExposeState | undefined;
}): DerivedWizardState {
  const hasAdmin = userCount(deps.db) > 0;
  // The wizard's first-vault provisioning uses the curated `vault` short,
  // which maps to `parachute-vault` in services.json.
  const vaultSpec = specFor(FIRST_VAULT_SHORT);
  const vaultEntry = findService(vaultSpec.manifestName, deps.manifestPath);
  // hub#607: distinguish the SEED placeholder from a real vault instance.
  // `parachute init` installs the vault MODULE without creating an instance
  // (hub#168 Cut 1: `noCreate`), seeding a services.json entry at
  // SEED_VERSION ("0.0.0-linked") with the canonical `/vault/default` mount.
  // Vault's own first-boot overwrites that entry with the real instance once
  // a vault is actually created. A bare `findService(...) !== undefined`
  // check matches the placeholder, so on EVERY init'd box the wizard treated
  // the vault step as already-done and skipped straight to expose — the
  // operator finished setup with no vault and no prompt. Treat a
  // SEED_VERSION row as "module installed, no instance" so the wizard still
  // presents its create / import / skip step. This is the SAME
  // discrimination `buildWellKnown` gained in hub#577 (it suppresses the
  // phantom `vaults[]` row at SEED_VERSION); both surfaces must agree that a
  // placeholder is not a real vault.
  const vaultIsPlaceholder = vaultEntry !== undefined && vaultEntry.version === SEED_VERSION;
  // INVARIANT (B5 re-enterable vault step): hasRealVault means "a real
  // instance row exists" — placeholder excluded here, skip-marker excluded
  // below (skip flips hasVault, never hasRealVault). THREE sites key on this
  // same placeholder logic and must move together: this derivation,
  // handleSetupGet's `?step=vault` re-entry gate, and handleSetupVaultPost's
  // already-provisioned short-circuit. Changing one without the others
  // either re-opens a provisioning form over a real vault or dead-ends the
  // post-skip re-entry path.
  const hasRealVault = vaultEntry !== undefined && !vaultIsPlaceholder;
  // hub#168 Cut 2: `setup_vault_skipped === "true"` advances the wizard
  // past the vault step even when no vault row exists. The operator
  // explicitly chose Skip; the module is installed (Cut 1) but no
  // instance was provisioned. Treat as "vault step is done" for the
  // purposes of state-derivation so the wizard moves to expose.
  const vaultSkipped = getSetting(deps.db, "setup_vault_skipped") === "true";
  const hasVault = hasRealVault || vaultSkipped;
  // Expose-mode is the operator's "how will this hub be reached?" answer
  // (hub#268 Item 2). Stored as a hub_setting; the wizard's expose step
  // sets it; absence means we should still ask. EXCEPT — if we're
  // running on a platform where the answer is pre-determined (e.g.
  // Render exposes the service at $RENDER_EXTERNAL_URL automatically),
  // auto-seed `setup_expose_mode = "public"` so the wizard skips the
  // expose step entirely. The operator landed here through a deploy
  // path that already answered the question; asking again wastes a
  // click and surfaces irrelevant options (localhost, tailnet).
  if (
    getSetting(deps.db, "setup_expose_mode") === undefined &&
    detectAutoExposeMode(deps.env ?? process.env) === "public"
  ) {
    setSetting(deps.db, "setup_expose_mode", "public");
  }
  // hub#406 team-onboarding bug: `setup_expose_mode` (the wizard's
  // answer) and `expose-state.json` (the live tailscale exposure) are
  // orthogonal axes. An operator who ran `parachute expose tailnet`
  // before opening the wizard has a live tailnet layer but no
  // `setup_expose_mode` setting — so the wizard re-asked "how will this
  // hub be reached?" even though tailnet was already up. Auto-seed the
  // setting from the live exposure layer (tailnet→"tailnet",
  // public→"public") so the answered-by-action case is treated as
  // satisfied, mirroring the Render/Fly auto-seed above. Reading the
  // live state is injected for testability (defaults to the real
  // reader); a malformed/missing file falls through to "still ask."
  if (getSetting(deps.db, "setup_expose_mode") === undefined) {
    const seeded = exposeModeFromLiveState(deps.readExposeStateFn ?? readExposeState);
    if (seeded !== undefined) {
      setSetting(deps.db, "setup_expose_mode", seeded);
    }
  }
  // hub Caddy-direct case: a reverse-proxy box (`parachute init --hub-origin
  // https://<host>`, or `parachute hub set-origin`) persists a real public
  // origin to `hub_settings.hub_origin` (also honored from PARACHUTE_HUB_ORIGIN).
  // That origin already answers "how is this hub reached?" — Caddy/Let's-Encrypt
  // fronts the loopback hub, no `parachute expose` and no Render/Fly env var.
  // Auto-seed `setup_expose_mode = "public"` so the wizard skips the expose step
  // exactly as the Render/Fly + live-tailscale branches do. `sanitizePublicOrigin`
  // (the SAME guard `resolveIssuer`/`exposeIssuerOrigin` use) requires an absolute
  // http(s) URL and REJECTS loopback/0.0.0.0 — so a laptop/loopback/unset origin
  // returns undefined and the expose step still renders (the operator chooses).
  if (getSetting(deps.db, "setup_expose_mode") === undefined) {
    const configured =
      sanitizePublicOrigin(getHubOrigin(deps.db) ?? undefined) ??
      sanitizePublicOrigin(deps.env?.PARACHUTE_HUB_ORIGIN ?? process.env.PARACHUTE_HUB_ORIGIN);
    if (configured !== undefined) {
      setSetting(deps.db, "setup_expose_mode", "public");
    }
  }
  const hasExposeMode = getSetting(deps.db, "setup_expose_mode") !== undefined;
  let step: WizardStep;
  // Note: `"account"` is a visual-only step in the progress header —
  // welcome's POST creates the admin and advances directly to `"vault"`,
  // so we never return `"account"` here.
  if (!hasAdmin) step = "welcome";
  else if (!hasVault) step = "vault";
  else if (!hasExposeMode) step = "expose";
  else step = "done";
  return { step, hasAdmin, hasVault, hasRealVault, hasExposeMode };
}

// --- handler types -------------------------------------------------------

export interface SetupWizardDeps {
  db: Database;
  manifestPath: string;
  configDir: string;
  /**
   * Optional supervisor. Present under `parachute serve` (container
   * mode); absent under the on-box CLI surface. The wizard refuses
   * step-3 POSTs when absent — the operator is expected to use the CLI
   * (`parachute install vault`) in that posture, not the web wizard.
   */
  supervisor?: Supervisor;
  /**
   * Hub origin string for the JWT `iss` claim plumbed through to install
   * ops. Defaults to the hub's own loopback issuer when unset (consistent
   * with the rest of hub-server.ts when no PARACHUTE_HUB_ORIGIN is
   * configured).
   */
  issuer: string;
  /**
   * Test seam: inject an operations registry so the wizard's tests can
   * observe its install op without colliding with the default
   * process-singleton. Production omits this; both the API surface and
   * the wizard then share the same default registry, which is correct —
   * an `/api/modules/operations/:id` poll from the SPA can pick up an
   * op created by the wizard if for some reason a stale tab is open.
   */
  registry?: OperationsRegistry;
  /** Test seam: stub `bun add` / `bun remove` runner. */
  run?: (cmd: readonly string[]) => Promise<number>;
  /**
   * Test seam: stub the bun-link detection used by `runInstall` to
   * short-circuit `bun add -g` when a package is already linked
   * locally (smoke 2026-05-27 finding 1). Production omits this and
   * the production detection at `src/bun-link.ts` probes the real
   * filesystem. Tests that need to assert "bun add -g WAS called"
   * pass `() => false`; tests asserting the skip path pass `() => true`.
   *
   * Threaded through to `ApiModulesOpsDeps.isLinked` on every
   * `runInstall` call from the wizard.
   */
  isLinked?: (pkg: string) => boolean;
  /**
   * Test seam: override the process env that `detectAutoExposeMode`
   * consults. Production omits this and the helper reads `process.env`
   * directly. Setting in tests lets the auto-skip branch be exercised
   * without mutating the real process env.
   */
  env?: Record<string, string | undefined>;
  /**
   * Test seam: inject the live-exposure reader `deriveWizardState`
   * consults to auto-seed `setup_expose_mode` from a live
   * `parachute expose tailnet|public` (hub#406). Production omits this
   * and the real `readExposeState` is used. Mirrors `init.ts`'s
   * `readExposeStateFn` seam.
   */
  readExposeStateFn?: () => ExposeState | undefined;
  /**
   * Test seam for the fresh-box operator-token closure (design §3.1 /
   * Phase 3b Deliverable A). After the wizard creates the first admin, it
   * persists `~/.parachute/operator.token` so the box has a CLI operator
   * credential the moment it gains an admin — without it, the Phase 3b
   * per-module verbs (`parachute start/stop/restart <svc>` driving the
   * supervisor) would 401 on a freshly-bootstrapped box. Production omits
   * this and uses the real {@link issueOperatorToken}; tests inject a stub
   * to assert the call (or to make it throw and prove a token-write failure
   * never fails account creation).
   */
  issueOperatorToken?: (
    db: Database,
    userId: string,
    opts: MintOperatorTokenOpts & { dir?: string },
  ) => Promise<IssueOperatorTokenResult>;
  /**
   * Whether the in-flight request arrived over loopback (peer `127.0.0.1` /
   * `::1`). Set by `hub-server.ts` from `layerOf(req, peerAddr)`. hub#576: a
   * loopback caller already proves on-box access (it's the operator's own
   * shell — `parachute init` driving the CLI wizard), so the GET `/admin/setup`
   * JSON probe reveals the actual bootstrap token VALUE to it, not just the
   * `requireBootstrapToken` boolean. Public / tailnet callers (any browser
   * that found the FQDN) get only the boolean and must paste the token the
   * operator copied from their terminal. Absent (undefined) is treated as
   * NON-loopback — fail closed, never leak the token to a header-less caller.
   */
  requestIsLoopback?: boolean;
}

/**
 * Returns `"public"` when the runtime env indicates the hub is deployed
 * on a platform where the "how will this hub be reached?" answer is
 * pre-determined by the platform. Today: Render (sets RENDER_EXTERNAL_URL)
 * and Fly.io (sets FLY_APP_NAME, reachable at `<app>.fly.dev`). Returns
 * `undefined` otherwise — the wizard's expose step asks the operator.
 *
 * Why this matters: on a managed PaaS, none of the three radio options
 * (localhost, tailnet, public-with-custom-domain) match the actual
 * setup. The hub is reached at the platform-assigned URL automatically.
 * Asking the operator wastes a click and surfaces three options that
 * don't speak to their situation. Auto-pinning `public` skips the step.
 *
 * Add more platforms here when we encounter them — e.g. Railway
 * (RAILWAY_ENVIRONMENT), DigitalOcean App Platform (DIGITALOCEAN_APP_*),
 * etc. Each only auto-detects when the platform clearly owns the public URL.
 */
export function detectAutoExposeMode(
  env: Record<string, string | undefined>,
): "public" | undefined {
  // Render always sets `RENDER_EXTERNAL_URL` to a real `https://` URL on
  // any web service. `startsWith("https://")` is the precise shape; we
  // also accept `http://` as a defensive fallback in case Render ever
  // changes the scheme on some plan tier. Anything else (empty, weird,
  // not a URL) → don't auto-skip; let the operator choose.
  const renderUrl = env.RENDER_EXTERNAL_URL;
  if (
    typeof renderUrl === "string" &&
    (renderUrl.startsWith("https://") || renderUrl.startsWith("http://"))
  ) {
    return "public";
  }
  // Fly.io sets FLY_APP_NAME (the app slug) on every machine. Unlike
  // Render, Fly doesn't auto-inject a public-URL env var — but every
  // Fly app on shared TLS is reachable at `<app>.fly.dev`, so the
  // presence of FLY_APP_NAME is the canonical "we're on Fly with a
  // public URL" signal. Validate it's a plausible slug (non-empty,
  // no scheme weirdness) before trusting it.
  const flyApp = env.FLY_APP_NAME;
  if (typeof flyApp === "string" && flyApp.length > 0 && !flyApp.includes("/")) {
    return "public";
  }
  return undefined;
}

// --- rendering -----------------------------------------------------------

function baseDocument(title: string, body: string, autoRefresh?: number): string {
  const refresh = autoRefresh ? `<meta http-equiv="refresh" content="${autoRefresh}" />` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="referrer" content="no-referrer" />
  ${refresh}
  <style>${STYLES}</style>
</head>
<body>
  <main>
${body}
  </main>
</body>
</html>`;
}

function header(currentStep: WizardStep): string {
  const stepOrder: WizardStep[] = ["welcome", "account", "vault", "expose", "done"];
  // Step 1 (welcome) + step 2 (account) collapse on the rendered page —
  // we show them as a single combined form. The progress bar still names
  // them separately so the operator sees the shape.
  const labels: Record<WizardStep, string> = {
    welcome: "Welcome",
    account: "Account",
    vault: "Vault",
    expose: "Expose",
    done: "Done",
  };
  const items = stepOrder
    .map((s) => {
      const current = s === currentStep;
      const past = stepOrder.indexOf(s) < stepOrder.indexOf(currentStep);
      const cls = current ? "step current" : past ? "step past" : "step";
      const marker = past ? "✓" : `${stepOrder.indexOf(s) + 1}`;
      return `<li class="${cls}"><span class="step-marker">${marker}</span><span class="step-label">${escapeHtml(labels[s])}</span></li>`;
    })
    .join("");
  return `
        <div class="brand">
          <span class="brand-mark" aria-hidden="true">${brandMarkSvg(20, "setup-wizard")}</span>
          <span class="brand-name">${WORDMARK_TEXT}</span>
          <span class="brand-tag">first-boot setup</span>
        </div>
        <ol class="steps">${items}</ol>`;
}

// --- step 1 + 2: welcome + account ---------------------------------------

export interface RenderAccountStepProps {
  csrfToken: string;
  errorMessage?: string;
  /** Pre-fill the username field after a validation failure. */
  username?: string;
  /**
   * Whether the bootstrap-token field should render and be required.
   * True under `parachute serve` wizard mode (no admin, no env-seed) —
   * `commands/serve.ts` mints + logs the token on boot and the form
   * requires it to claim the admin row. False on the on-box CLI surface
   * (the operator already has shell access; gating the form behind a
   * token they'd also need to read from logs adds friction with no
   * security gain).
   *
   * UX: when true, the token field is the FIRST field on the form so
   * an operator who hasn't seen the log line stops here rather than
   * filling username + password and bouncing off a 401.
   */
  requireBootstrapToken?: boolean;
  /**
   * Pre-fill the bootstrap-token field after a validation failure on a
   * field OTHER than the token itself. We never echo a wrong token back
   * — the form re-renders with an empty token field so the operator has
   * to re-look-up the correct value.
   */
  bootstrapToken?: string;
}

export function renderAccountStep(props: RenderAccountStepProps): string {
  const { csrfToken, errorMessage, username, requireBootstrapToken, bootstrapToken } = props;
  const error = errorMessage ? `<p class="error-banner">${escapeHtml(errorMessage)}</p>` : "";
  // Pre-fill "owner" on a fresh render (no prior submission) so the web wizard's
  // default matches the CLI paths (`set-password`, `setup-wizard`) + the
  // operator.token convention. Operators can still type any name. On a
  // validation-failure re-render we echo back what they typed instead.
  const usernameAttr = ` value="${escapeAttr(username ?? "owner")}"`;
  const tokenAttr = bootstrapToken ? ` value="${escapeAttr(bootstrapToken)}"` : "";
  // Bootstrap-token field comes FIRST when required. An operator who
  // missed the log line is stopped here rather than after filling
  // username + password.
  const bootstrapField = requireBootstrapToken
    ? `
        <label class="field">
          <span class="field-label">Bootstrap token</span>
          <input type="text" name="bootstrap_token" autocomplete="off"
            autofocus required minlength="20" maxlength="200"
            spellcheck="false" autocapitalize="off"
            placeholder="${escapeAttr(BOOTSTRAP_TOKEN_PREFIX)}…"${tokenAttr} />
          <span class="field-hint">Find this in your hub's startup logs.
            Look for the <code>${escapeHtml(BOOTSTRAP_TOKEN_PREFIX)}</code> line.</span>
        </label>`
    : "";
  // When the token is required we drop `autofocus` off the username field
  // so it doesn't fight the token field's focus.
  const usernameAutofocus = requireBootstrapToken ? "" : " autofocus";
  const tokenCallout = requireBootstrapToken
    ? `<aside class="bootstrap-callout">
        <strong>One-time setup credential.</strong> This hub was deployed without
        baked-in admin credentials, so it generated a one-time bootstrap token
        on startup. Paste it below to claim the admin account. The token
        expires once the admin is created (or when the hub restarts).
      </aside>`
    : "";
  const body = `
    <div class="card">
      <div class="card-header">
        ${header("welcome")}
        <h1>Welcome to your Parachute hub</h1>
        <p class="subtitle">Two quick steps and you'll have a working stack —
          an admin account and your first vault. No email, no signup; this
          all stays on your machine (or your container).</p>
      </div>
      <section class="explainer">
        <h2>Why this step</h2>
        <p>A Parachute hub needs one admin operator before anything else can
          run — OAuth issuance, vault provisioning, the admin UI all need
          an identity behind them.</p>
        <h2>What's next</h2>
        <p>After this you'll name your first vault. The hub will install it
          and issue a token your Claude Code MCP client can use.</p>
      </section>
      ${tokenCallout}
      ${error}
      <form method="POST" action="/admin/setup/account" class="auth-form">
        ${renderCsrfHiddenInput(csrfToken)}
        ${bootstrapField}
        <label class="field">
          <span class="field-label">Username</span>
          <input type="text" name="username" autocomplete="username"${usernameAutofocus}
            required minlength="2" maxlength="64"
            pattern="[A-Za-z0-9_.-]+" title="letters, digits, _ . - (2–64 chars)"
            ${usernameAttr} />
          <span class="field-hint">letters, digits, <code>_</code>, <code>.</code>, <code>-</code></span>
        </label>
        <label class="field">
          <span class="field-label">Password</span>
          <input type="password" name="password" autocomplete="new-password"
            required minlength="8" />
          <span class="field-hint">at least 8 characters</span>
        </label>
        <label class="field">
          <span class="field-label">Confirm password</span>
          <input type="password" name="password_confirm" autocomplete="new-password"
            required minlength="8" />
        </label>
        <button type="submit" class="btn btn-primary">Create admin & continue</button>
      </form>
      <details class="alt-path">
        <summary>Prefer to seed via env vars?</summary>
        <p>Set <code>PARACHUTE_INITIAL_ADMIN_USERNAME</code> and
          <code>PARACHUTE_INITIAL_ADMIN_PASSWORD</code> on the container and
          restart. The hub will create the admin row on next boot and skip this
          wizard (no bootstrap token needed — the env vars themselves are the
          claim).</p>
      </details>
    </div>`;
  return baseDocument("Set up your Parachute hub — account", body);
}

// --- step 3: vault -------------------------------------------------------

export interface RenderVaultStepProps {
  csrfToken: string;
  errorMessage?: string;
  /** Pre-fill the vault name input after a validation failure. */
  vaultName?: string;
  /**
   * When the runtime is a hosted container (Render / Fly), the scribe
   * sub-form hides the "local provider" option — Whisper / parakeet
   * don't run usefully in the constrained container. Defaults to false
   * (treat as self-host, show local option) — production wizard renders
   * always pass an explicit value via detectAutoExposeMode.
   */
  cloudHost?: boolean;
  /**
   * When an install op is in progress, render the polling shape: no
   * form, just the op log + auto-refresh.
   */
  operation?: {
    id: string;
    status: "pending" | "running" | "succeeded" | "failed";
    log: readonly string[];
    error?: string;
    /**
     * Optional scribe install op_id, threaded through so the success
     * redirect carries `&op_scribe=<id>` and the done step picks up the
     * in-flight scribe install via the existing per-tile op-poll
     * mechanism (`buildInstallTiles` reads `op_<short>` query param).
     */
    scribeOpId?: string;
  };
}

export function renderVaultStep(props: RenderVaultStepProps): string {
  const { csrfToken, errorMessage, operation, vaultName, cloudHost } = props;
  if (operation) return renderVaultOpStep({ operation });
  const error = errorMessage ? `<p class="error-banner">${escapeHtml(errorMessage)}</p>` : "";
  // hub#168 Cut 2: three-branch vault step. The browser form now sends
  // `mode=create|import|skip` along with the existing vault_name. Defaults
  // to create when nothing's selected (back-compat with pre-#168 form
  // posts that didn't ship a mode field — still works through the same
  // handler). The radio's `data-shows` attribute drives an inline
  // <script> block that hides import-specific fields when create/skip
  // is selected. No SPA bundle, no module deps — same posture as the
  // existing scribe sub-form's mode-switching JS.
  // hub#267: the typed name now flows end-to-end via
  // `PARACHUTE_VAULT_NAME`. Vault#342 added the env var read on
  // first-boot — hub spawns vault with the env var set and vault's
  // `resolveFirstBootVaultName` picks it up. The wizard's job here is
  // to ask + validate + persist the choice; the supervised vault child
  // does the rest.
  //
  // Leaving the field blank falls back to `default` server-side —
  // matches the prior shape so no-input + Submit still works for the
  // "I don't care, just give me a vault" path.
  const nameAttr = vaultName !== undefined ? ` value="${escapeAttr(vaultName)}"` : "";
  const previewName = vaultName?.trim() ? escapeHtml(vaultName.trim()) : DEFAULT_VAULT_NAME;
  const body = `
    <div class="card">
      <div class="card-header">
        ${header("vault")}
        <h1>Create your first vault</h1>
        <p class="subtitle">A vault is the per-workspace SQLite store + MCP
          surface Claude reads and writes through. You can have many vaults
          on one hub; this is just the first.</p>
      </div>
      <section class="explainer">
        <h2>Why this step</h2>
        <p>The wizard provisions a vault module at the path
          <code>/vault/&lt;name&gt;</code> and issues you an operator token —
          the same shape <code>parachute install vault</code> produces from
          the CLI. We're doing both in one click.</p>
        <h2>What's next</h2>
        <p>You'll land on a success screen with copy-paste MCP install
          instructions for Claude Code and a link to the admin UI, where
          you can add more vaults.</p>
      </section>
      <section class="preview">
        <p class="preview-label">About to create</p>
        <div class="preview-card">
          <span class="preview-key">vault:</span>
          <span class="preview-val" id="preview-vault-name">${previewName}</span>
          <span class="preview-fine">— admin: you, MCP-ready for Claude Code</span>
        </div>
        <p class="preview-fine">
          The name shows up in the MCP URL (<code>/vault/&lt;name&gt;/mcp</code>)
          and on the admin UI. You can add or manage vaults later from the
          vault module's own admin at <code>/vault/admin/</code>.
        </p>
      </section>
      ${error}
      <form method="POST" action="/admin/setup/vault" class="auth-form">
        ${renderCsrfHiddenInput(csrfToken)}
        <fieldset class="vault-mode-block">
          <legend class="field-label">How do you want to start?</legend>
          <label class="vault-mode-option">
            <input type="radio" name="mode" value="create" checked data-shows="name" />
            <span class="vault-mode-title">Create a new vault</span>
            <span class="vault-mode-desc">Start fresh. The wizard creates an empty vault under the name below.</span>
          </label>
          <label class="vault-mode-option">
            <input type="radio" name="mode" value="import" data-shows="name,import" />
            <span class="vault-mode-title">Import from a git repo</span>
            <span class="vault-mode-desc">Clone a previously-exported vault from GitHub / GitLab / any HTTPS git remote.</span>
          </label>
          <label class="vault-mode-option">
            <input type="radio" name="mode" value="skip" data-shows="" />
            <span class="vault-mode-title">Skip — create a vault later</span>
            <span class="vault-mode-desc">The vault module is installed; create or import a vault any time from the admin UI.</span>
          </label>
        </fieldset>
        <label class="field vault-name-field">
          <span class="field-label">Vault name</span>
          <input type="text" name="vault_name"
            autofocus minlength="2" maxlength="32"
            pattern="[a-z0-9_-]+"
            title="lowercase letters, digits, hyphens, underscores (2–32 chars)"
            placeholder="${DEFAULT_VAULT_NAME}"${nameAttr} />
          <span class="field-hint">lowercase letters, digits, <code>-</code>, <code>_</code>;
            2–32 chars. Leave blank for <code>${DEFAULT_VAULT_NAME}</code>.</span>
        </label>
        <fieldset class="vault-import-block" style="display: none;">
          <legend class="field-label">Import source</legend>
          <label class="field">
            <span class="field-label">Remote URL</span>
            <input type="text" name="remote_url" spellcheck="false" autocomplete="off"
              placeholder="https://github.com/you/your-vault.git" />
            <span class="field-hint">HTTPS or SSH clone URL. The repo must be a Parachute vault export — i.e. it carries a <code>.parachute/vault.yaml</code> at the root.</span>
          </label>
          <label class="field">
            <span class="field-label">Personal access token (optional)</span>
            <input type="password" name="pat" autocomplete="off"
              placeholder="ghp_… / glpat-… / etc." />
            <span class="field-hint">Required for private repos. Used in-memory for this import only — not stored. Set up push credentials later from the vault's mirror settings.</span>
          </label>
          <label class="vault-mode-option">
            <input type="radio" name="import_mode" value="merge" checked />
            <span class="vault-mode-title">Merge into a fresh vault (default)</span>
            <span class="vault-mode-desc">Recommended on a brand-new install — the vault starts empty, so merge is effectively "import everything."</span>
          </label>
          <label class="vault-mode-option">
            <input type="radio" name="import_mode" value="replace" />
            <span class="vault-mode-title">Replace (wipes any existing notes first)</span>
            <span class="vault-mode-desc">Only useful if you re-ran the wizard on an existing vault. Otherwise picks the same shape as merge.</span>
          </label>
        </fieldset>
        ${renderScribeSubForm(cloudHost === true)}
        <button type="submit" class="btn btn-primary">Continue</button>
      </form>
      <script>
        (function () {
          // Show/hide vault-name + import block based on the picked mode.
          // The radio carries data-shows listing the visible block suffixes
          // (name, import); the show/hide loop reads them and flips display
          // on the matching block. Skip mode hides everything below the
          // mode picker.
          var radios = document.querySelectorAll('input[name="mode"]');
          var nameField = document.querySelector('.vault-name-field');
          var importBlock = document.querySelector('.vault-import-block');
          function sync() {
            var picked = document.querySelector('input[name="mode"]:checked');
            var shows = picked ? (picked.dataset.shows || '') : '';
            var nameVisible = shows.indexOf('name') !== -1;
            var importVisible = shows.indexOf('import') !== -1;
            if (nameField) nameField.style.display = nameVisible ? '' : 'none';
            if (importBlock) importBlock.style.display = importVisible ? '' : 'none';
          }
          radios.forEach(function (r) { r.addEventListener('change', sync); });
          sync();
        })();
      </script>
    </div>`;
  return baseDocument("Set up your Parachute hub — vault", body);
}

/**
 * Scribe install sub-form embedded in the vault step (folded in
 * 2026-05-27 per Aaron's team-meeting directive: "folding the scribe
 * question into the vault step is a good idea"). Operator answers
 * scribe-related questions in the same form as vault name, the POST
 * handler kicks both installs in parallel, and the done screen polls
 * scribe's progress via the existing per-tile op-poll mechanism.
 *
 * The provider list adapts to the runtime context:
 *   - Cloud container (Render / Fly): local transcribers (parakeet,
 *     whisper) don't fit in 512MB + can't reach hardware acceleration.
 *     We hide them. Groq is the default (fast cloud Whisper, ~$0.04/hr
 *     of audio); OpenAI is the alternative.
 *   - Local (Mac / Linux): parakeet-mlx is the default on Mac (silicon
 *     MLX); falls back to onnx-asr cross-platform. Cloud providers
 *     stay available as choices for operators who'd rather pay than
 *     run local inference.
 *
 * The API key input shows conditionally — only when a cloud provider
 * is selected. It's a plain text input (no `type=password`) because
 * (a) the operator just pasted it from their provider's dashboard, and
 * (b) showing it lets them verify they pasted correctly before submit.
 * Mode-switching between providers via the radio is handled by an
 * inline `<script>` block — no SPA bundle, no module deps.
 *
 * The "Skip — no transcription" option is third and unchecked by
 * default. Most operators want voice transcription once they know
 * they can; the default-on posture matches the auto-transcribe default
 * flip that landed in vault#373.
 */
function renderScribeSubForm(cloudHost: boolean): string {
  const localBlock = cloudHost
    ? ""
    : `
        <label class="scribe-provider-option">
          <input type="radio" name="scribe_provider" value="local"${cloudHost ? "" : " checked"} data-needs-key="false" />
          <span class="provider-name">Local <small>(Mac MLX or ONNX — no API key needed)</small></span>
        </label>`;
  const groqDefault = cloudHost ? " checked" : "";
  // Cleanup providers that need a host-side binary or local server
  // (claude-code → `claude` CLI + `claude setup-token`; ollama → local
  // Ollama server) are hidden on cloud hosts (Render / Fly). The
  // remaining cloud-friendly choices (anthropic / openai / groq /
  // gemini) stay visible — they only need an API key.
  const claudeCodeCleanupBlock = cloudHost
    ? ""
    : `
              <label class="scribe-provider-option">
                <input type="radio" name="scribe_cleanup_provider" value="claude-code" data-needs-key="false" />
                <span class="provider-name">Claude Code <small>(subscription auth — run <code>claude setup-token</code> on this host)</small></span>
              </label>`;
  const ollamaCleanupBlock = cloudHost
    ? ""
    : `
              <label class="scribe-provider-option">
                <input type="radio" name="scribe_cleanup_provider" value="ollama" data-needs-key="false" />
                <span class="provider-name">Ollama <small>(local LLM — requires Ollama running on this machine)</small></span>
              </label>`;
  return `
        <details class="scribe-suboptions" open>
          <summary class="cursor-pointer">
            <span class="field-label">Enable voice transcription</span>
            <span class="field-hint"> · Scribe installs alongside vault, transcribes audio attachments automatically</span>
          </summary>
          <div class="scribe-provider-block">
            <p class="field-hint">Pick a transcription provider. You can change this later in <code>/admin/modules</code>.</p>
            <div class="scribe-provider-list">
              ${localBlock}
              <label class="scribe-provider-option">
                <input type="radio" name="scribe_provider" value="groq"${groqDefault} data-needs-key="true" />
                <span class="provider-name">Groq <small>(~\$0.04/hr of audio, fast)</small></span>
              </label>
              <label class="scribe-provider-option">
                <input type="radio" name="scribe_provider" value="openai" data-needs-key="true" />
                <span class="provider-name">OpenAI Whisper <small>(~\$0.36/hr of audio)</small></span>
              </label>
              <label class="scribe-provider-option">
                <input type="radio" name="scribe_provider" value="none" data-needs-key="false" />
                <span class="provider-name">Skip — no transcription</span>
              </label>
            </div>
            <label class="field scribe-api-key-field" data-shows-on="cloud">
              <span class="field-label">API key</span>
              <input type="password" name="scribe_api_key" autocomplete="off" placeholder="gsk_… or sk-…" />
              <span class="field-hint">Pasted directly into <code>~/.parachute/scribe/config.json</code> on this hub (file mode 0o600). Leave blank to skip and set later in the admin SPA.</span>
            </label>
            <fieldset class="scribe-cleanup-block">
              <legend class="field-label">Cleanup <small>(optional LLM polish pass on transcripts)</small></legend>
              <p class="field-hint">After transcription, scribe can run a cleanup pass to fix punctuation, capitalization, and obvious transcription glitches. Pick a provider, or skip.</p>
              <div class="scribe-provider-list">
                <label class="scribe-provider-option">
                  <input type="radio" name="scribe_cleanup_provider" value="none" checked data-needs-key="false" />
                  <span class="provider-name">Skip cleanup <small>(default — raw transcripts only)</small></span>
                </label>
                ${claudeCodeCleanupBlock}
                <label class="scribe-provider-option">
                  <input type="radio" name="scribe_cleanup_provider" value="anthropic" data-needs-key="true" />
                  <span class="provider-name">Anthropic API <small>(needs ANTHROPIC_API_KEY)</small></span>
                </label>
                ${ollamaCleanupBlock}
                <label class="scribe-provider-option">
                  <input type="radio" name="scribe_cleanup_provider" value="openai" data-needs-key="true" />
                  <span class="provider-name">OpenAI <small>(needs OPENAI_API_KEY)</small></span>
                </label>
                <label class="scribe-provider-option">
                  <input type="radio" name="scribe_cleanup_provider" value="groq" data-needs-key="true" />
                  <span class="provider-name">Groq <small>(needs GROQ_API_KEY)</small></span>
                </label>
                <label class="scribe-provider-option">
                  <input type="radio" name="scribe_cleanup_provider" value="gemini" data-needs-key="true" />
                  <span class="provider-name">Google Gemini <small>(needs GOOGLE_API_KEY)</small></span>
                </label>
              </div>
              <label class="field scribe-cleanup-api-key-field" style="display: none;">
                <span class="field-label">Cleanup API key</span>
                <input type="password" name="scribe_cleanup_api_key" autocomplete="off" placeholder="sk-ant-… or sk-… or gsk-…" />
                <span class="field-hint">Pasted directly into <code>~/.parachute/scribe/config.json</code> on this hub (file mode 0o600). Leave blank to skip and paste later in the admin SPA.</span>
              </label>
            </fieldset>
          </div>
        </details>
        <script>
          (function () {
            function toggle(radioName, keySelector) {
              var radios = document.querySelectorAll('input[name="' + radioName + '"]');
              var keyField = document.querySelector(keySelector);
              function sync() {
                var selected = document.querySelector('input[name="' + radioName + '"]:checked');
                var needsKey = selected && selected.dataset.needsKey === "true";
                if (keyField) keyField.style.display = needsKey ? "" : "none";
              }
              radios.forEach(function (r) { r.addEventListener("change", sync); });
              sync();
            }
            toggle("scribe_provider", ".scribe-api-key-field");
            toggle("scribe_cleanup_provider", ".scribe-cleanup-api-key-field");
          })();
        </script>
  `;
}

function renderVaultOpStep(props: {
  operation: NonNullable<RenderVaultStepProps["operation"]>;
}): string {
  const { operation } = props;
  const terminal = operation.status === "succeeded" || operation.status === "failed";
  const logLines = operation.log.map((l) => `<li>${escapeHtml(l)}</li>`).join("");
  const errBanner = operation.error
    ? `<p class="error-banner">${escapeHtml(operation.error)}</p>`
    : "";
  // Auto-refresh every 2s until terminal. When succeeded we redirect via
  // a tiny refresh-to-/admin/setup?just_finished=1 so the wizard
  // re-renders the success screen one more time (with the MCP install
  // command + vault name) before subsequent bare GETs 301 to /login.
  // Without the `?just_finished=1` query, the success state derives as
  // "complete" + GET 301s, and the operator never sees the done page.
  // When failed we leave the operator on this screen so they can read
  // the log.
  const refresh = terminal ? undefined : 2;
  const body = `
    <div class="card">
      <div class="card-header">
        ${header("vault")}
        <h1>${operation.status === "succeeded" ? "Vault ready" : "Provisioning your vault…"}</h1>
        <p class="subtitle">${
          operation.status === "failed"
            ? "Something went wrong — see the log below."
            : operation.status === "succeeded"
              ? "All set. Continuing to the success screen…"
              : "This usually takes 10–60 seconds. The page refreshes itself."
        }</p>
      </div>
      ${errBanner}
      <section class="op-log">
        <p class="op-status op-${operation.status}">status: ${operation.status}</p>
        <ol class="log-lines">${logLines}</ol>
      </section>
      ${
        operation.status === "succeeded"
          ? `<meta http-equiv="refresh" content="1; url=/admin/setup?just_finished=1${operation.scribeOpId ? `&op_scribe=${encodeURIComponent(operation.scribeOpId)}` : ""}" />`
          : ""
      }
    </div>`;
  return baseDocument("Set up your Parachute hub — vault", body, refresh);
}

// --- step 4: expose ------------------------------------------------------

export interface RenderExposeStepProps {
  csrfToken: string;
  errorMessage?: string;
  /** Pre-select a radio when re-rendering after a validation error. */
  selectedMode?: SetupExposeMode;
}

/**
 * The expose step asks the operator how this hub will be reached. The
 * wizard doesn't configure tailscale or DNS itself — the operator owns
 * the actual networking step; the wizard's role is to ask the question,
 * surface the right next-step instructions, and persist the choice so
 * the done page (and the admin SPA later) shows the right URL shape.
 *
 * Three modes (hub#268 Item 2):
 *   * localhost — just this machine. No further action; the loopback
 *     URL is the canonical entry.
 *   * tailnet   — Tailscale network. Show the `tailscale serve` command
 *     the operator runs themselves.
 *   * public    — custom domain / reverse proxy. Show a brief explainer
 *     + link to the deploy docs.
 */
export function renderExposeStep(props: RenderExposeStepProps): string {
  const { csrfToken, errorMessage, selectedMode } = props;
  const error = errorMessage ? `<p class="error-banner">${escapeHtml(errorMessage)}</p>` : "";
  // The default selection (localhost) is the most common case + the
  // safest fallback — picking it changes nothing operational. Tailnet +
  // public require the operator to actually run something; surfacing
  // them as alternatives is the whole point of this step.
  const sel = (m: SetupExposeMode) => (selectedMode === m ? " checked" : "");
  const defaultChecked = selectedMode === undefined ? " checked" : "";
  const body = `
    <div class="card">
      <div class="card-header">
        ${header("expose")}
        <h1>How will this hub be reached?</h1>
        <p class="subtitle">Pick the network shape that matches your setup.
          You can revisit this later from the admin UI — it just shapes the
          URLs we surface on the next screen.</p>
      </div>
      ${error}
      <form method="POST" action="/admin/setup/expose" class="auth-form expose-form">
        ${renderCsrfHiddenInput(csrfToken)}
        <label class="expose-option">
          <input type="radio" name="expose_mode" value="localhost"${selectedMode ? sel("localhost") : defaultChecked} />
          <div class="expose-option-body">
            <span class="expose-option-title">Just this machine (localhost)</span>
            <span class="expose-option-desc">Reach the hub at
              <code>http://localhost:1939</code>. No further configuration
              needed. This is the right answer for "I'm just trying it out"
              and for "this machine is the only client."</span>
          </div>
        </label>
        <label class="expose-option">
          <input type="radio" name="expose_mode" value="tailnet"${sel("tailnet")} />
          <div class="expose-option-body">
            <span class="expose-option-title">My Tailscale network</span>
            <span class="expose-option-desc">Share with your own devices over
              a private tailnet. After finishing setup, run:</span>
            <pre class="expose-option-cmd">tailscale serve --bg --https=1939 http://localhost:1939</pre>
            <span class="expose-option-desc">The hub is then reachable at
              your tailnet hostname (e.g.
              <code>https://my-mac.tailnet-name.ts.net</code>) from any of
              your logged-in devices.</span>
          </div>
        </label>
        <label class="expose-option">
          <input type="radio" name="expose_mode" value="public"${sel("public")} />
          <div class="expose-option-body">
            <span class="expose-option-title">Public URL (custom domain)</span>
            <span class="expose-option-desc">Run the hub behind a reverse
              proxy on a domain you own. See the
              <a href="https://parachute.computer/docs/deploy" target="_blank" rel="noopener">deploy guide</a>
              for nginx / Caddy / Cloudflare Tunnel examples + the env
              vars (<code>PARACHUTE_HUB_ORIGIN</code>) the hub reads for
              its own canonical URL.</span>
          </div>
        </label>
        <button type="submit" class="btn btn-primary">Continue</button>
      </form>
    </div>`;
  return baseDocument("Set up your Parachute hub — expose", body);
}

// --- step 5: done --------------------------------------------------------

/**
 * Per-module install state surfaced on the done screen (hub#272 Item B).
 * The renderer reads this to choose tile shape:
 *   * `idle` — no op yet, show the Install button + form
 *   * `running` / `pending` — op-poll panel + auto-refresh
 *   * `succeeded` — green check + "View in admin" link
 *   * `failed` — red banner + log + retry button
 *
 * Same op-id flows through the admin SPA's operation poll, so an
 * operator can hop to `/admin/modules` mid-flight and watch from there
 * without losing the op.
 */
export interface ModuleInstallTileState {
  short: CuratedModuleShort;
  displayName: string;
  tagline: string;
  /** True when a services.json entry already exists for this module (already installed). */
  alreadyInstalled: boolean;
  /** Live op snapshot from the registry, if `?op_<short>=<id>` was set. */
  operation?: {
    id: string;
    status: "pending" | "running" | "succeeded" | "failed";
    log: readonly string[];
    error?: string;
  };
}

export interface RenderDoneStepProps {
  vaultName: string;
  /** Hub origin used in copy-pastable MCP install commands. */
  hubOrigin: string;
  /**
   * Operator's expose-mode choice from step 4. Shapes the "Your hub is
   * reachable at:" line + next-step instructions. Optional for back-compat
   * with callers that render the done step without going through expose
   * (e.g. tests of the wizard's older two-step flow).
   */
  exposeMode?: SetupExposeMode;
  /**
   * Optional per-module install tiles to render alongside the MCP
   * command (hub#272 Item B). When omitted, the done step renders
   * only the MCP tile + the admin-UI fallback link. Production wires
   * Notes + Scribe; tests can omit this to assert the back-compat
   * shape.
   */
  installTiles?: readonly ModuleInstallTileState[];
}

export function renderDoneStep(props: RenderDoneStepProps): string {
  const { vaultName, hubOrigin, exposeMode, installTiles } = props;
  const reachable = exposeMode ? renderReachableTile(exposeMode, hubOrigin) : "";
  const mcpTile = renderMcpTile(vaultName, hubOrigin);
  const tiles = installTiles && installTiles.length > 0 ? installTiles : [];
  const installSection = tiles.length > 0 ? renderInstallTiles(tiles) : "";
  const startTile = renderStartUsingTile(vaultName, hubOrigin);
  // The done-grid hosts the MCP-connect tile + the admin-UI fallback.
  // The install tiles sit above it as a "what's next?" surface (curated
  // catalog of modules an operator might want next). The "Start using
  // your vault" tile leads everything user-facing because it answers
  // Aaron's hub#342 friction directly: there was no clear way from the
  // wizard's done screen to actually USE Parachute — the wizard
  // surfaced "install more" + "go to admin" + an MCP command, none of
  // which is "open the canonical user-facing UI" (Notes via App). With
  // this tile in pole position, the operator's first click goes to a
  // surface that says "hello, here's your vault" rather than a hub
  // admin page. The reachable tile sits above even the start tile
  // because "where's my hub?" answers the URL question every operator
  // hits before they can click anything else (especially on tailnet /
  // public expose where the loopback URL isn't the answer).
  const body = `
    <div class="card">
      <div class="card-header">
        ${header("done")}
        <h1>You're set up</h1>
        <p class="subtitle">Your hub is ready. Here's what to do next.</p>
      </div>
      ${reachable}
      ${startTile}
      ${renderStarterPromptsSection()}
      ${installSection}
      <section class="done-grid">
        ${mcpTile}
        <div class="done-tile">
          <h2>Open the admin UI</h2>
          <p>Manage vaults, tokens, OAuth grants, and module updates.</p>
          <p><a class="btn btn-secondary" href="/admin/modules">Go to admin</a></p>
        </div>
      </section>
      <section class="explainer">
        <h2>What just happened</h2>
        <ul>
          <li>An admin operator account was created on this hub.</li>
          <li>A vault named <code>${escapeHtml(vaultName)}</code> was installed and started.</li>
          <li>OAuth issuer + JWKS keys were minted (visible at
            <code>/.well-known/oauth-authorization-server</code>).</li>
        </ul>
        <p>This wizard won't come back — the next visitor to <code>/</code>
          sees the discovery page; visitors to <code>/admin</code> are routed
          to <code>/login</code>.</p>
      </section>
    </div>`;
  // Auto-refresh while any install op is in flight so the operator sees
  // progress without manually reloading. Done step is the canonical
  // poll surface for both the MCP-connect tile (static) and the
  // module-install tiles (dynamic). Refresh interval matches the
  // vault-op-poll page's 2s cadence so the wizard's two long-running
  // surfaces (vault, post-vault notes/scribe) feel consistent.
  const anyOpInFlight = tiles.some(
    (t) => t.operation && (t.operation.status === "pending" || t.operation.status === "running"),
  );
  const refresh = anyOpInFlight ? 2 : undefined;
  return baseDocument("Parachute hub — setup complete", body, refresh);
}

/**
 * The MCP-connect tile. Renders the bare `claude mcp add` command —
 * no token, no `--header`. Vault/init is OAuth-default (parachute-vault
 * #491), so the command triggers browser OAuth on first use: the
 * operator signs in to this hub + approves access, and Claude Code
 * stores the resulting credential. For headless clients that can't do
 * the browser flow, the fine print points at `/admin/tokens` (the
 * canonical mint surface) + the `--header "Authorization: Bearer
 * <token>"` form they append themselves.
 *
 * History: an earlier build (hub#272 Item A) auto-minted a full-scope
 * operator token here and pre-filled the command with a Bearer header
 * + a masked-reveal/Copy widget. That was removed 2026-06-23 (Austen's
 * report): header-auth was the wrong default once vault went OAuth-
 * default, and baking an admin-scope bearer into a copy-pasted command
 * was a privilege over-grant + a shoulder-surf hazard. The bare OAuth
 * command was always the correct UX; it's now the only one.
 */
function renderMcpTile(vaultName: string, hubOrigin: string): string {
  const safeVault = escapeHtml(vaultName);
  const bareCmd = `claude mcp add --transport http parachute-${vaultName} ${hubOrigin}/vault/${vaultName}/mcp`;
  return `<div class="done-tile">
    <h2>Connect Claude Code (MCP)</h2>
    <p>Wire <code>vault:${safeVault}</code> into Claude Code as an MCP server:</p>
    <pre>${escapeHtml(bareCmd)}</pre>
    <p class="fine">No token needed — the command triggers browser OAuth on
      first use (you sign in to this hub and approve access). For headless
      clients that can't do the browser flow, mint a hub token at
      <a href="/admin/tokens"><code>/admin/tokens</code></a> (or with
      <code>parachute auth mint-token</code>) and append
      <code>--header "Authorization: Bearer &lt;token&gt;"</code>.</p>
  </div>`;
}

/**
 * The "Start using your vault" lead tile on the done step (hub#342,
 * Aaron 2026-05-27 simplification).
 *
 * Closes Aaron's "no clear way to go from setting up parachute to
 * actually using parachute" friction. Sits above the MCP / install
 * tiles because it's the canonical user-facing entry point —
 * everything else on the done screen is operator-flavored (MCP
 * command, admin UI, additional module installs).
 *
 * Points at the canonical notes.parachute.computer hosted PWA as the
 * primary CTA — with the operator's own hub URL pre-filled via
 * `?url=` so the connect screen auto-populates + auto-focuses
 * (notes-ui AddVault route, see
 * parachute-surface/packages/notes-ui/src/app/routes/AddVault.tsx).
 * Secondary CTA: "Open vault admin" (the vault's own admin UI on this
 * hub) for operators who want to look at raw vault state.
 *
 * Previously varied by whether `parachute-surface` was installed
 * locally — pointing at `/surface/notes/` in that case. Dropped
 * 2026-05-27: hub+vault+scribe is the focus; notes.parachute.computer
 * is canonical regardless of local surface install state.
 */
function renderStartUsingTile(vaultName: string, hubOrigin: string): string {
  const safeVault = escapeHtml(vaultName);
  // Vault names pass `/^[a-z0-9][a-z0-9-]*$/i` so URL-encoding is mostly
  // a no-op today, but use encodeURIComponent defensively to match hub.ts:505.
  const urlVault = encodeURIComponent(vaultName);
  // The `?url=` query param is consumed by notes-ui's AddVault route
  // (packages/notes-ui/src/app/routes/AddVault.tsx) — it pre-fills the
  // vault URL input + auto-focuses Submit.
  const vaultUrlForAdd = encodeURIComponent(`${hubOrigin.replace(/\/+$/, "")}/vault/${vaultName}`);
  return `<section class="start-using" data-testid="start-using-tile">
    <h2>Start using your vault</h2>
    <p>Open Notes — the canonical browser UI for your vault <code>${safeVault}</code>.
      It connects to your hub over HTTPS and remembers your URL after the first OAuth.</p>
    <p><a class="btn btn-primary" href="https://notes.parachute.computer/add?url=${vaultUrlForAdd}" target="_blank" rel="noopener">Open Notes ↗</a></p>
    <p class="start-using-secondary">
      <a href="/vault/${urlVault}/admin/">Or browse the vault's admin UI →</a>
    </p>
  </section>`;
}

/**
 * Starter-prompts tile on the done screen. Surfaces the two
 * interview-style prompts hosted at parachute.computer:
 *
 *   1. "Help me set up my vault" — AI interviews the operator about
 *      where their data lives + proposes a tag/path structure
 *      (parachute.computer/onboarding/vault-setup/).
 *   2. "Build a custom UI" — AI builds a static SPA against the vault's
 *      HTTP API, hosted on the operator's own GitHub Pages
 *      (parachute.computer/onboarding/surface-build/).
 *
 * Aaron 2026-05-27 directive: ship these as the "first AI assist"
 * surface so freshly-onboarded operators have a clear next thing to
 * do beyond clicking around the admin UI. The prompts live on
 * parachute.computer rather than embedded in the wizard so they can
 * be iterated without a hub release; the wizard just links.
 */
function renderStarterPromptsSection(): string {
  return `<section class="starter-prompts" data-testid="starter-prompts">
    <h2>Get help from your AI</h2>
    <p class="starter-prompts-subtitle">Two interview-style prompts to paste into Claude Code or Codex once your vault's MCP is wired up.</p>
    <div class="starter-prompts-grid">
      <a class="starter-prompt-tile" href="https://parachute.computer/onboarding/vault-setup/" target="_blank" rel="noopener">
        <h3>Set up your vault</h3>
        <p>Interview-style. AI asks where your notes live now + proposes a tag &amp; path structure that fits how you actually think.</p>
        <p class="starter-prompt-cta">Open prompt ↗</p>
      </a>
      <a class="starter-prompt-tile" href="https://parachute.computer/onboarding/surface-build/" target="_blank" rel="noopener">
        <h3>Build a custom UI</h3>
        <p>AI generates a static SPA hosted on your own GitHub Pages — talks to your vault over HTTP. Notes UI works as a reference.</p>
        <p class="starter-prompt-cta">Open prompt ↗</p>
      </a>
    </div>
  </section>`;
}

/**
 * The "What's next?" install-tiles row (hub#272 Item B). One tile per
 * curated module the operator might want next (Notes, Scribe). Each
 * tile is either an install form (POST → /admin/setup/install/<short>
 * → 303 to /admin/setup?op_<short>=<id>) or an op-poll panel mirroring
 * the vault-step's op-poll shape.
 */
function renderInstallTiles(tiles: readonly ModuleInstallTileState[]): string {
  const items = tiles.map((t) => renderInstallTile(t)).join("");
  return `<section class="install-tiles">
    <h2 class="install-tiles-heading">What's next?</h2>
    <p class="install-tiles-subtitle">Install another module — these run alongside your vault on the same hub.</p>
    <div class="install-grid">${items}</div>
  </section>`;
}

function renderInstallTile(tile: ModuleInstallTileState): string {
  const safeShort = escapeHtml(tile.short);
  const safeName = escapeHtml(tile.displayName);
  const safeTagline = escapeHtml(tile.tagline);
  const useItNowUrl = USE_IT_NOW_URLS[tile.short];
  // "Use it now" → the canonical user-facing URL per
  // module-ui-declaration.md, rendered as the PRIMARY action on a
  // succeeded / already-installed install tile (hub#342). "Manage
  // modules" stays as the secondary affordance so the admin SPA is
  // one click away too. The URL table is keyed by the wizard's
  // curated shorts (app, scribe today; vault excluded since the
  // wizard owns its step); modules with no known surface fall
  // through to a single "Manage modules" link, same as pre-#342.
  if (tile.operation) {
    const op = tile.operation;
    const logLines = op.log.map((l) => `<li>${escapeHtml(l)}</li>`).join("");
    const errBanner = op.error ? `<p class="error-banner">${escapeHtml(op.error)}</p>` : "";
    // Terminal state (succeeded / failed) gets either a confirmation
    // link or a retry form. Pending / running renders the live log
    // panel and relies on the parent `<meta http-equiv="refresh">` for
    // the next tick — no per-tile refresh needed (one full-page reload
    // catches every in-flight op at once).
    let actions = "";
    if (op.status === "succeeded") {
      const useItNowLink = useItNowUrl
        ? `<a class="btn btn-primary" href="${escapeAttr(useItNowUrl)}">Use it now</a>`
        : "";
      actions = `<p class="install-tile-actions">
        ${useItNowLink}
        <a class="btn btn-secondary" href="/admin/modules">Manage modules</a>
      </p>`;
    } else if (op.status === "failed") {
      actions = `<form method="POST" action="/admin/setup/install/${safeShort}" class="install-retry">
        ${renderInstallTileCsrfPlaceholder()}
        <button type="submit" class="btn btn-secondary">Retry install</button>
      </form>`;
    }
    return `<div class="install-tile install-tile-${op.status}">
      <h3>${safeName}</h3>
      <p class="install-tile-tagline">${safeTagline}</p>
      ${errBanner}
      <section class="op-log install-tile-log">
        <p class="op-status op-${op.status}">status: ${op.status}</p>
        <ol class="log-lines">${logLines}</ol>
      </section>
      ${actions}
    </div>`;
  }
  if (tile.alreadyInstalled) {
    const useItNowLink = useItNowUrl
      ? `<a class="btn btn-primary" href="${escapeAttr(useItNowUrl)}">Use it now</a>`
      : "";
    return `<div class="install-tile install-tile-installed">
      <h3>${safeName}</h3>
      <p class="install-tile-tagline">${safeTagline}</p>
      <p class="install-tile-status">Already installed.</p>
      <p class="install-tile-actions">
        ${useItNowLink}
        <a class="btn btn-secondary" href="/admin/modules">Manage in admin</a>
      </p>
    </div>`;
  }
  return `<div class="install-tile">
    <h3>${safeName}</h3>
    <p class="install-tile-tagline">${safeTagline}</p>
    <form method="POST" action="/admin/setup/install/${safeShort}" class="install-tile-form">
      ${renderInstallTileCsrfPlaceholder()}
      <button type="submit" class="btn btn-primary">Install ${safeName}</button>
    </form>
  </div>`;
}

/**
 * Canonical "Use it now" target per curated module short (hub#342).
 * Each value is the canonical user-facing URL the module ships its UI
 * at — per `module-ui-declaration.md` (`uiUrl` / `managementUrl` rules).
 * App's surface is the bundled Notes-as-UI auto-bootstrap mount;
 * Scribe is the operator-facing admin UI (per `module-surfaces.md`,
 * scribe's admin surface is at `/scribe/admin` once an admin SPA ships
 * — scribe#53 tracks). Missing entries here fall through to "Manage
 * modules" only — i.e. modules without a declared first-party UI
 * surface. Vault is intentionally omitted: the wizard's own vault
 * step owns the post-vault-install flow and the lead "Start using
 * your vault" tile (above the install row) handles the vault-side
 * surface decision.
 */
const USE_IT_NOW_URLS: Partial<Record<CuratedModuleShort, string>> = {
  // Empty: vault has its own lead "Start using" tile (the
  // notes.parachute.computer CTA), so it doesn't appear here. Scribe
  // doesn't ship an admin SPA at /scribe/admin/ that's useful for
  // first-time operators (the page exists but it's config-management;
  // not "use it"). Re-add per-module entries here if/when a module
  // ships a user-facing landing surface worth pointing at.
};

/**
 * CSRF token placeholder for install-tile forms. The token comes from
 * the wizard's per-request CSRF cookie; rendered by the parent step's
 * `csrfToken` plumbing. Threaded through `renderDoneStep` props rather
 * than read here directly because the tile renderer is a pure function
 * the test surface can exercise without a request object.
 *
 * Currently rendered as a marker that the parent renderer rewrites
 * before serving — keeps the per-tile shape pure but avoids dragging
 * a CSRF token argument into every tile-shape function.
 */
function renderInstallTileCsrfPlaceholder(): string {
  return INSTALL_TILE_CSRF_PLACEHOLDER;
}

const INSTALL_TILE_CSRF_PLACEHOLDER = "__INSTALL_TILE_CSRF__";

/**
 * Render the "Your hub is reachable at" tile on the done step, shaped by
 * the operator's expose-mode choice. Always surfaces the loopback URL as
 * an anchor (the operator's own browser hits the wizard on it); the
 * tail-end instructions reframe based on what they picked.
 */
function renderReachableTile(mode: SetupExposeMode, hubOrigin: string): string {
  const safeOrigin = escapeHtml(hubOrigin);
  if (mode === "localhost") {
    return `<section class="reachable">
      <h2>Your hub is reachable at</h2>
      <p class="reachable-url"><code>${safeOrigin}</code></p>
      <p class="fine">Local to this machine only. Want to share it with your
        other devices? Re-visit setup later from the admin UI or run
        <code>tailscale serve --bg --https=1939 http://localhost:1939</code>
        from a terminal.</p>
    </section>`;
  }
  if (mode === "tailnet") {
    return `<section class="reachable">
      <h2>Your hub is reachable at</h2>
      <p class="reachable-url"><code>${safeOrigin}</code> (loopback, this machine)</p>
      <p class="reachable-url">Plus your tailnet URL once you run:</p>
      <pre>tailscale serve --bg --https=1939 http://localhost:1939</pre>
      <p class="fine">The Tailscale CLI prints the public hostname (e.g.
        <code>my-mac.tailnet-name.ts.net</code>); use that on your phone /
        other devices.</p>
    </section>`;
  }
  // public
  return `<section class="reachable">
      <h2>Your hub is reachable at</h2>
      <p class="reachable-url"><code>${safeOrigin}</code> (loopback, this machine)</p>
      <p class="fine">Wire a reverse proxy on your domain to
        <code>${safeOrigin}</code>, then set <code>PARACHUTE_HUB_ORIGIN</code>
        to your public URL and restart the hub. See the
        <a href="https://parachute.computer/docs/deploy">deploy guide</a>
        for nginx / Caddy / Cloudflare Tunnel examples.</p>
    </section>`;
}

// --- handler entry points ------------------------------------------------

/**
 * GET `/admin/setup`. Derives state, renders the appropriate step.
 *
 * Once the wizard's work is done (admin + vault both exist), GET 301s
 * to `/login` so a stale bookmark lands somewhere useful — UNLESS the
 * caller's `?just_finished=1` query is set, in which case we render the
 * step-4 done screen one more time. The wizard's own success redirect
 * uses `?just_finished=1` so the operator sees step 4 even though state
 * is already "complete."
 */
export function handleSetupGet(req: Request, deps: SetupWizardDeps): Response {
  const url = new URL(req.url);
  const state = deriveWizardState(deps);
  const csrf = ensureCsrfToken(req);
  const wantsJson = wantsJsonResponse(req);
  // CLI wizard surface (hub#168 Cut 3): the GET endpoint doubles as a
  // state-probe API. Same state-derivation, same DB read; only the
  // response shape forks on Accept. Returning the JSON envelope before
  // the HTML rendering branches means the CLI gets the answer it needs
  // without the wizard having to render a 30KB HTML page per poll.
  if (wantsJson) {
    const activeToken = getBootstrapToken();
    const requireToken = activeToken !== undefined;
    const envelope: {
      step: typeof state.step;
      hasAdmin: boolean;
      hasVault: boolean;
      hasExposeMode: boolean;
      requireBootstrapToken: boolean;
      csrfToken: string;
      bootstrapToken?: string;
      operation?: {
        id: string;
        status: "pending" | "running" | "succeeded" | "failed";
        log: readonly string[];
        error?: string;
      };
    } = {
      step: state.step,
      hasAdmin: state.hasAdmin,
      hasVault: state.hasVault,
      hasExposeMode: state.hasExposeMode,
      requireBootstrapToken: requireToken,
      csrfToken: csrf.token,
    };
    // hub#616: the CLI wizard polls vault-provisioning over THIS session-authed
    // surface (mirroring the browser wizard's `/admin/setup?op=<id>` re-GET),
    // not the Bearer-gated `/api/modules/operations/:id` the SPA + install CLI
    // use. The wizard holds only a session cookie mid-setup; the op endpoint
    // requires a host-admin Bearer it doesn't have, so a direct poll 401s and
    // the vault step dies. Threading the op snapshot into the envelope keeps the
    // poll on the auth the wizard already carries.
    const opId = url.searchParams.get("op");
    if (opId) {
      // hub#618: post-setup this JSON `?op=` surface is unauth-reachable —
      // `/admin/setup` is always lockout-exempt (the dispatcher's
      // `shouldGateForSetup` lets it through so a stale bookmark resolves), and
      // the snapshot is read BEFORE any session check. The leak is small (an
      // in-memory op's status + install-progress log lines, behind an
      // unguessable UUID), but it's still a post-setup admin surface, so gate
      // it once setup is COMPLETE. During setup (no admin yet) the surface
      // stays OPEN: the unauth CLI wizard (`parachute init`) AND the brand-new-
      // operator browser both poll this `?op=` snapshot mid-setup before any
      // session exists — gating then would break first-boot vault
      // provisioning. Loopback always passes (same on-box trust as the
      // `bootstrapToken` branch below); a valid session also passes.
      const setupComplete = state.hasAdmin && state.hasVault && state.hasExposeMode;
      const opSnapshotAllowed =
        !setupComplete ||
        deps.requestIsLoopback === true ||
        findActiveSession(deps.db, req) !== null;
      if (opSnapshotAllowed) {
        const op = deps.registry?.get(opId);
        if (op) {
          envelope.operation = {
            id: op.id,
            status: op.status,
            log: op.log,
            ...(op.error !== undefined ? { error: op.error } : {}),
          };
        }
      }
    }
    // hub#576: hand the actual token to a LOOPBACK caller only. The on-box
    // operator (`parachute init` → CLI wizard, or a curl from their own shell)
    // already proves box access by reaching loopback — same trust level as
    // reading the token off the startup banner in the hub log. This lets init
    // surface the token in the operator's terminal and feed it to the CLI
    // wizard transparently, instead of making them dig through `parachute logs
    // hub`. A public / tailnet browser never gets the value — it stays gated on
    // the operator pasting what they copied from their terminal.
    if (requireToken && deps.requestIsLoopback === true && activeToken !== undefined) {
      envelope.bootstrapToken = activeToken;
    }
    const jsonHeaders: Record<string, string> = {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    };
    if (csrf.setCookie) jsonHeaders["set-cookie"] = csrf.setCookie;
    return new Response(JSON.stringify(envelope), { status: 200, headers: jsonHeaders });
  }
  const extraHeaders: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
  };
  if (csrf.setCookie) extraHeaders["set-cookie"] = csrf.setCookie;

  // Re-enterable vault step (B5, 2026-06-09 hub-module-boundary migration).
  // A wizard-skip leaves the vault MODULE installed with no instances and no
  // daemon (hub#607's zero-instances state) — and `setup_vault_skipped`
  // makes `hasVault` true, so a plain GET resumes at expose/done and the
  // create form is unreachable. The hub-side "create your first vault"
  // affordance (Home's vault card + the legacy /admin/vaults empty state)
  // deep-links `?step=vault`, which re-enters the create/import form as long
  // as no REAL vault instance exists. Session-gated: post-account the box
  // has an admin, and re-opening a provisioning form to a drive-by GET
  // would leak setup state (the POST is session+CSRF-gated either way).
  // With a real vault present the param is ignored and the normal flow
  // (expose step / 301 → /login) runs.
  //
  // INVARIANT: this gate keys on `hasRealVault` (deriveWizardState) — the
  // same placeholder logic handleSetupVaultPost's short-circuit uses. The
  // three sites must move together; see the derivation comment in
  // deriveWizardState.
  if (url.searchParams.get("step") === "vault" && state.hasAdmin && !state.hasRealVault) {
    const session = findActiveSession(deps.db, req);
    if (!session) {
      // Preserve the CSRF set-cookie across the bounce — same shape as the
      // `?just_finished=1` session gate below.
      const redirectHeaders: Record<string, string> = {
        location: `/login?next=${encodeURIComponent("/admin/setup?step=vault")}`,
      };
      if (csrf.setCookie) redirectHeaders["set-cookie"] = csrf.setCookie;
      return new Response(null, { status: 302, headers: redirectHeaders });
    }
    const cloudHost = detectAutoExposeMode(deps.env ?? process.env) === "public";
    return new Response(renderVaultStep({ csrfToken: csrf.token, cloudHost }), {
      status: 200,
      headers: extraHeaders,
    });
  }

  // Setup fully complete (including expose-mode choice) — redirect to
  // /login unless we're rendering the success page once. The success
  // page sets `?just_finished=1` and the session cookie is on the
  // request from step 2.
  if (state.hasAdmin && state.hasVault && state.hasExposeMode) {
    if (url.searchParams.get("just_finished") === "1") {
      // hub#274 security fold: session-gate this branch. Originally this
      // protected the `setup_minted_token` read-and-consume below (a
      // full-scope operator JWT a racing client could have walked off
      // with). The auto-mint was removed 2026-06-23 (Austen's report —
      // vault is OAuth-default now, see the expose POST), so no secret
      // is surfaced here anymore. The gate stays: the done screen is a
      // post-setup admin surface and shouldn't render to a drive-by
      // unauthenticated GET. The dispatcher in `hub-server.ts`'s
      // `shouldGateForSetup` lets `/admin/setup*` through the pre-admin
      // lockout, and that path stays open post-setup — so this gate has
      // to live here, not at the dispatcher layer.
      //
      // A legitimate operator carrying the session cookie minted on
      // the account POST sails through. A drive-by GET without the
      // cookie 302s to /login.
      const session = findActiveSession(deps.db, req);
      if (!session) {
        // Preserve the CSRF set-cookie header on the 302 — same shape as
        // every other branch of this handler. Without it, a freshly
        // assigned CSRF token would be lost across the redirect, and
        // form posts from a sign-in-then-come-back flow would 400 on
        // their first attempt.
        const redirectHeaders: Record<string, string> = { location: "/login" };
        if (csrf.setCookie) redirectHeaders["set-cookie"] = csrf.setCookie;
        return new Response(null, {
          status: 302,
          headers: redirectHeaders,
        });
      }
      const stored = getSetting(deps.db, "setup_expose_mode");
      const exposeMode = isSetupExposeMode(stored) ? stored : undefined;
      // No minted-token read here anymore — the auto-mint was removed
      // 2026-06-23 (Austen's report). The done step always renders the
      // bare OAuth `claude mcp add` command (no Bearer header), which is
      // the correct UX for OAuth-default vaults. Headless clients mint a
      // scoped token at /admin/tokens themselves (the bare tile points
      // there). The defensive `deleteSetting` below clears any stale row
      // a pre-upgrade hub left behind, so it never leaks on first render
      // after upgrade.
      if (getSetting(deps.db, "setup_minted_token") !== undefined) {
        deleteSetting(deps.db, "setup_minted_token");
      }
      // Prefer the LIVE vault name from services.json over the
      // operator-typed value cached in hub_settings (smoke
      // 2026-05-27, finding 2). The cached value is what the
      // operator typed into the wizard form — fine on the happy
      // path, but stale if the vault install failed and the
      // operator worked around it (e.g. installed vault under a
      // different name via the CLI). The "static-write + stale-
      // read" pattern Aaron's flagged repeatedly:
      // `feedback_static_vs_dynamic_state.md`. Read state
      // dynamically when it can change.
      //
      // Fall back to the DB setting only if services.json has no
      // vault entry — covers a transient "wizard hit done but
      // vault is still pending" race where the operator-typed
      // value is the only signal we have. Final fallback is
      // "default" so the rendered name is always something the
      // operator can act on.
      const liveName = firstVaultNameOrNull(deps.manifestPath);
      const storedName = getSetting(deps.db, "setup_vault_name");
      const vaultName = liveName ?? storedName ?? "default";
      // Module install tiles (hub#272 Item B). One per curated module
      // other than vault (which the wizard already provisioned).
      const installTiles = buildInstallTiles(url, deps);
      // The lead "Start using your vault" tile points at
      // notes.parachute.computer/add — always, regardless of any
      // local module install state. Prior versions of this code
      // checked `isModuleInstalled("surface", ...)` to switch to a
      // local `/surface/notes/` link, but the launch focus is
      // hub+vault+scribe and notes.parachute.computer is the
      // canonical Notes UI (Aaron-directed 2026-05-27). Dropped the
      // local-fallback branch.
      const doneProps: RenderDoneStepProps = {
        vaultName,
        hubOrigin: deps.issuer,
        installTiles,
      };
      if (exposeMode !== undefined) doneProps.exposeMode = exposeMode;
      // No `doneProps.mintedToken` — see the OAuth-default note above.
      // Substitute CSRF placeholder for the install-tile forms with
      // the current CSRF token. Keeping the per-tile renderer pure
      // means the substitution lives here (one rewrite per render).
      const html = renderDoneStep(doneProps).replaceAll(
        INSTALL_TILE_CSRF_PLACEHOLDER,
        renderCsrfHiddenInput(csrf.token),
      );
      return new Response(html, {
        status: 200,
        headers: extraHeaders,
      });
    }
    return new Response(null, { status: 301, headers: { location: "/login" } });
  }

  // Expose step (hub#268 Item 2). Admin + vault exist, but the operator
  // hasn't picked an expose mode yet. The wizard form posts to
  // /admin/setup/expose. Gated on having an admin session (the session
  // cookie was minted on step 2); on a stale tab without it, the post
  // handler shows the no-session error.
  if (state.hasAdmin && state.hasVault && !state.hasExposeMode) {
    return new Response(renderExposeStep({ csrfToken: csrf.token }), {
      status: 200,
      headers: extraHeaders,
    });
  }

  // Step 3 (vault) with an op in flight — render the poll page.
  if (state.hasAdmin && !state.hasVault) {
    const opId = url.searchParams.get("op");
    const cloudHost = detectAutoExposeMode(deps.env ?? process.env) === "public";
    if (opId) {
      const registry = deps.registry;
      const op = registry?.get(opId);
      if (op) {
        // Carry the scribe op_id forward via the query param so the
        // op-poll page's success-redirect threads it into the done
        // step's URL (where buildInstallTiles picks it up via the
        // existing per-tile `op_scribe` mechanism).
        const scribeOpIdParam = url.searchParams.get("op_scribe") ?? undefined;
        return new Response(
          renderVaultStep({
            csrfToken: csrf.token,
            cloudHost,
            operation: {
              id: op.id,
              status: op.status,
              log: op.log,
              ...(op.error !== undefined ? { error: op.error } : {}),
              ...(scribeOpIdParam !== undefined ? { scribeOpId: scribeOpIdParam } : {}),
            },
          }),
          { status: 200, headers: extraHeaders },
        );
      }
    }
    return new Response(renderVaultStep({ csrfToken: csrf.token, cloudHost }), {
      status: 200,
      headers: extraHeaders,
    });
  }

  // Step 1+2 (no admin yet). Render with the bootstrap-token field iff a
  // token is currently active — `commands/serve.ts` only mints one on
  // wizard-mode boot (no env-seed), so the field's presence is a 1:1
  // signal of "the operator needs a token to claim this hub." On the
  // on-box CLI surface and on env-seed-followed-by-deleted-admin paths,
  // the token is absent and the form renders the historical shape.
  const requireToken = getBootstrapToken() !== undefined;
  return new Response(
    renderAccountStep({
      csrfToken: csrf.token,
      requireBootstrapToken: requireToken,
    }),
    {
      status: 200,
      headers: extraHeaders,
    },
  );
}

/**
 * POST `/admin/setup/account`. Form-encoded.
 *
 * Validates CSRF + form fields, creates the admin row, mints a session
 * cookie, redirects to `/admin/setup` (which then renders step 3).
 *
 * Rejects if a user already exists — re-arriving here after step 2 is
 * either a stale tab or a malicious double-submit; either way the right
 * answer is "you're done with this step, go to /admin/setup."
 */
export async function handleSetupAccountPost(
  req: Request,
  deps: SetupWizardDeps,
): Promise<Response> {
  const form = await readBodyFields(req);
  // JSON callers (CLI wizard, hub#168 Cut 3) generally don't have a
  // pre-existing CSRF cookie because the GET that returned the JSON
  // envelope just set one — the CLI's fetch is the first request and
  // the verifyCsrfToken's double-submit check needs the cookie + body
  // value to match. The wizard's GET surface sets the cookie; the CLI
  // reads it back from `Set-Cookie` and threads it on subsequent POSTs,
  // matching the browser behavior. CSRF verification is shared.
  const formCsrf = form.get(CSRF_FIELD_NAME);
  if (!verifyCsrfToken(req, typeof formCsrf === "string" ? formCsrf : null)) {
    if (form.isJson) {
      return jsonErrorResponse(400, "Invalid form submission", "Reload and try again.");
    }
    return badRequestPage("Invalid form submission", "Reload and try again.");
  }
  // Already-bootstrapped: bounce. The wizard's GET state will resolve to
  // step 3 or step 4 on the next request. We return 410 Gone for the
  // case where a bootstrap token was active this boot AND has already
  // been consumed by a prior POST — distinguishes "you missed your
  // window" from "this hub never had a wizard-mode boot" so a racing
  // attacker sees a hard-stop rather than a soft redirect.
  const csrfToken = typeof formCsrf === "string" ? formCsrf : "";
  const requireToken = getBootstrapToken() !== undefined;
  if (userCount(deps.db) > 0) {
    if (!requireToken) {
      if (form.isJson) {
        return jsonOkResponse({ step: "vault", message: "admin already exists" });
      }
      return redirect("/admin/setup");
    }
    // Defense in depth: a token was active but an admin already exists.
    // Treat as consumed.
    if (form.isJson) {
      return jsonErrorResponse(410, "Admin already claimed", "Bootstrap token was already used.");
    }
    return new Response(renderClaimAlreadyHappenedPage(), {
      status: 410,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  // Bootstrap-token gate. Only enforced when wizard mode is active —
  // env-seed admins never reach this path (they're admin-exists by
  // boot time), CLI mode never mints a token (the on-box operator
  // already has shell auth). Wrong token → 401 + form re-render with
  // an empty token field; right token → fall through.
  if (requireToken) {
    const suppliedToken = String(form.get("bootstrap_token") ?? "").trim();
    if (!verifyBootstrapToken(suppliedToken)) {
      if (form.isJson) {
        return jsonErrorResponse(
          401,
          "Bootstrap token rejected",
          "Re-check the `parachute-bootstrap-…` line in your hub's startup logs.",
        );
      }
      const username = String(form.get("username") ?? "").trim();
      return htmlResponse(
        renderAccountStep({
          csrfToken,
          username,
          requireBootstrapToken: true,
          // Deliberately do NOT echo the wrong supplied token back —
          // forces re-look-up rather than tab-completing a typo.
          errorMessage:
            "Wrong bootstrap token. Re-check your hub's startup logs for the " +
            "`parachute-bootstrap-…` line and try again.",
        }),
        401,
      );
    }
  }
  const username = String(form.get("username") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const confirm = String(form.get("password_confirm") ?? "");
  const fieldErr = validateAccountFields({ username, password, confirm });
  if (fieldErr) {
    if (form.isJson) {
      return jsonErrorResponse(400, "Invalid account fields", fieldErr);
    }
    return htmlResponse(
      renderAccountStep({
        csrfToken,
        username,
        // Re-render with the token field present iff still required (it
        // was valid this attempt — the field-error came from username/
        // password). Empty value so the operator pastes again.
        requireBootstrapToken: requireToken,
        errorMessage: fieldErr,
      }),
      400,
    );
  }
  try {
    // Wizard-admin chose their password through this very form; skip the
    // multi-user-Phase-1 force-change-password redirect by landing
    // `password_changed=true`. `assignedVault` stays null — admin posture
    // (the wizard never asks the first admin to pin themselves to a
    // single vault; that's a non-admin user pattern).
    const user = await createUser(deps.db, username, password, { passwordChanged: true });
    // Consume the bootstrap token AFTER the admin row is committed.
    // Doing it before would let a `createUser` exception (UNIQUE-collision,
    // disk full, anything) leave the token un-consumed but the admin row
    // partially written — and the operator without a way to retry.
    // Doing it after means a successful claim invalidates the token for
    // any racer who saw it over the operator's shoulder during the
    // window between log-print and form-submit.
    if (requireToken) consumeBootstrapToken();
    // Fresh-box operator-token closure (design §3.1 / Phase 3b Deliverable A).
    // The box now has its first admin — persist `operator.token` so it has a
    // CLI operator credential immediately. Without it, the Phase 3b per-module
    // verbs (start/stop/restart <svc> driving the supervisor over the
    // module-ops API) would 401 on a box bootstrapped purely through the
    // wizard. Runs AFTER the admin row + bootstrap-token are committed so a
    // half-written admin never gains a token; guarded so an existing token is
    // never clobbered; wrapped so a token-write failure NEVER fails the
    // account creation the operator just completed.
    await ensureOperatorTokenForFirstAdmin(deps, user.id);
    const session = createSession(deps.db, { userId: user.id });
    const cookie = buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000), {
      secure: isHttpsRequest(req),
    });
    if (form.isJson) {
      return jsonOkResponse({ step: "vault", message: "admin created" }, { "set-cookie": cookie });
    }
    return redirect("/admin/setup", { "set-cookie": cookie });
  } catch (err) {
    // Log the raw error server-side for the operator's debugging, but
    // surface a fixed string to the browser — raw SQLite / argon2
    // messages leak schema details and aren't actionable for the
    // person filling out the form. The likely cause for a sane input
    // is the username-taken UNIQUE collision (createUser raises
    // UsernameTakenError); other paths (filesystem, argon2 native)
    // are rare and the same generic message lands the operator at the
    // right place: retry, or `parachute auth set-password` from the
    // shell.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[setup-wizard] createUser failed for "${username}": ${msg}`);
    if (form.isJson) {
      return jsonErrorResponse(
        400,
        "Account creation failed",
        "Failed to create account. The username may already be taken.",
      );
    }
    return htmlResponse(
      renderAccountStep({
        csrfToken,
        username,
        requireBootstrapToken: requireToken,
        errorMessage: "Failed to create account. The username may already be taken.",
      }),
      400,
    );
  }
}

/**
 * Persist `~/.parachute/operator.token` for the just-created first admin
 * (design §3.1 / Phase 3b Deliverable A). The 3a reviewer flagged that a fresh
 * `init`→wizard flow ends with NO operator token on disk, so the Phase 3b
 * per-module verbs — `parachute start/stop/restart <svc>`, which now drive the
 * supervisor over the host-admin-gated module-ops API — would 401 on such a
 * box. Minting the token here makes the box have a CLI operator credential the
 * moment it gains an admin.
 *
 * Three invariants:
 *   - Mints under the `admin` scope-set (the default), which carries
 *     `parachute:host:admin` — exactly the scope `api-modules-ops.ts` gates on.
 *     `issueOperatorToken` writes it 0600 (`writeOperatorTokenFile`).
 *   - Guarded by `readOperatorTokenFile() === null`: never clobber a token an
 *     operator already minted (`auth set-password` / `rotate-operator`, or a
 *     prior init).
 *   - Wrapped in try/catch so a token-write failure NEVER fails the account
 *     creation the operator just completed — they have an admin row + session
 *     either way, and `parachute auth rotate-operator` is the documented
 *     recovery for a missing token.
 *
 * Uses `deps.issuer` as the `iss` claim — the same pre-resolved origin the rest
 * of the wizard's mints use (`handleSetupExposePost`). The hub-server derives
 * that origin the same way `commands/auth.ts:resolveHubIssuer` does — semantically
 * equivalent, structurally different: this path takes a pre-resolved `deps.issuer`
 * while `auth.ts` reads expose-state inline at call time. `start hub` self-heals a
 * stale `iss` later if the box is exposed after init (hub#481), so an
 * init-at-loopback mint is correct here.
 */
async function ensureOperatorTokenForFirstAdmin(
  deps: SetupWizardDeps,
  userId: string,
): Promise<void> {
  const issue = deps.issueOperatorToken ?? issueOperatorToken;
  try {
    const existing = await readOperatorTokenFile(deps.configDir);
    if (existing !== null) return;
    await issue(deps.db, userId, { issuer: deps.issuer, dir: deps.configDir });
  } catch (err) {
    // Non-fatal: the admin + session were already committed. Log for the
    // operator's debugging; they can recover with `parachute auth
    // rotate-operator` from a shell on the box.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[setup-wizard] operator-token closure skipped for new admin: ${msg}`);
  }
}

/**
 * Static error page surfaced when an `/admin/setup/account` POST arrives
 * after the bootstrap token has already been consumed by a successful
 * admin claim. Returned with HTTP 410 Gone (vs. the 302 redirect a
 * stale-tab without a token gets) so a scripted attacker reading the
 * status code sees an unmistakable "you missed the window" signal.
 *
 * No retry CTA — the wizard is past its account step; pointing the
 * operator at /login is the right answer.
 */
function renderClaimAlreadyHappenedPage(): string {
  const body = `
    <div class="card">
      ${header("account")}
      <h1 class="error-title">Admin already claimed</h1>
      <p class="subtitle">This hub's bootstrap token was already used to
        create the admin account. The token is one-shot — it can't be
        reused to claim a second admin or rotate the existing one.</p>
      <p class="subtitle">If you're the legitimate operator, sign in at
        <a href="/login"><code>/login</code></a>. If you've lost the
        password, restart the hub (which mints a fresh token) and use
        <code>parachute auth set-password</code> from a shell with
        access to the hub's PARACHUTE_HOME.</p>
      <p><a class="btn btn-primary" href="/login">Go to sign-in</a></p>
    </div>`;
  return baseDocument("Admin already claimed", body);
}

/**
 * POST `/admin/setup/vault`. Accepts `application/x-www-form-urlencoded`
 * (browser) and `application/json` (CLI wizard).
 *
 * Three modes (hub#168 Cut 2 — Aaron's 2026-05-28 directive): `mode`
 * field is the discriminant.
 *   * `create` (default if absent — back-compat with the pre-hub#168
 *     browser flow that didn't send `mode`): provision a new vault under
 *     the typed name.
 *   * `import`: provision an empty vault under the typed name, then
 *     POST to vault's `/vault/<name>/.parachute/mirror/import` endpoint
 *     with the supplied remote URL + optional PAT. Surfaces import
 *     progress through the same op-poll machinery used by the create
 *     path.
 *   * `skip`: don't create or import anything. The wizard advances to
 *     the expose step. The "vault module installed" signal is still
 *     true (init.ts pre-installed it under hub#168 Cut 1), but no
 *     instance exists — `deriveWizardState`'s `hasVault` reflects the
 *     services.json shape, which `skip` leaves untouched. To make the
 *     wizard *advance past* the vault step on skip we persist a
 *     `setup_vault_skipped` flag that `deriveWizardState` consults.
 *
 * Gated by the admin session cookie set at step 2 — a stale tab without
 * the cookie won't accidentally try to provision a vault. The session is
 * also valid evidence that the operator who created the admin is the
 * same one driving step 3 (they're necessarily the only user in
 * single-user mode).
 *
 * Browser shape: returns 303 to `/admin/setup?op=<id>` (create/import) or
 * `/admin/setup` (skip).
 * CLI shape: returns 200 JSON `{ op_id?, step }`.
 */
export async function handleSetupVaultPost(req: Request, deps: SetupWizardDeps): Promise<Response> {
  // Note: supervisor gate moved BELOW the mode check (hub#168 Cut 2) so
  // that `mode=skip` doesn't fail on the CLI hub surface (which doesn't
  // wire a supervisor — operators install vault via `parachute install
  // vault` on the on-box CLI path; the wizard's role there is the
  // account + skip + expose decisions only).
  const form = await readBodyFields(req);
  const formCsrf = form.get(CSRF_FIELD_NAME);
  if (!verifyCsrfToken(req, typeof formCsrf === "string" ? formCsrf : null)) {
    if (form.isJson) {
      return jsonErrorResponse(400, "Invalid form submission", "Reload and try again.");
    }
    return badRequestPage("Invalid form submission", "Reload and try again.");
  }
  const session = findActiveSession(deps.db, req);
  if (!session) {
    if (form.isJson) {
      return jsonErrorResponse(
        401,
        "No admin session",
        "Sign in to continue setup. The session cookie was set on step 2.",
      );
    }
    return badRequestPage(
      "No admin session",
      "Sign in to continue setup. (The wizard sets a session cookie on step 2; clearing cookies between steps will land you here.)",
    );
  }
  // Already done — short-circuit to the done step. Keyed on hasRealVault
  // (NOT hasVault): the `setup_vault_skipped` marker satisfies hasVault, but
  // a skipped box has no instance and the re-entered vault step (B5,
  // `?step=vault`) must be able to POST create/import — `mode=create` below
  // clears the skip marker; `mode=skip` just re-sets it (idempotent).
  //
  // INVARIANT: same placeholder logic as deriveWizardState's hasRealVault
  // derivation and handleSetupGet's `?step=vault` re-entry gate — the three
  // sites must move together; see the derivation comment in
  // deriveWizardState.
  const state = deriveWizardState(deps);
  if (state.hasRealVault) {
    if (form.isJson) {
      return jsonOkResponse({ step: "expose", message: "vault already provisioned" });
    }
    return redirect("/admin/setup?just_finished=1");
  }

  // Mode discriminant (hub#168 Cut 2). Default is "create" for back-
  // compat with the existing browser form — it doesn't send `mode`.
  const rawMode = String(form.get("mode") ?? "create").trim();
  if (rawMode !== "create" && rawMode !== "import" && rawMode !== "skip") {
    if (form.isJson) {
      return jsonErrorResponse(
        400,
        "Invalid vault mode",
        `mode must be one of create, import, skip (got "${rawMode}")`,
      );
    }
    return badRequestPage("Invalid vault mode", "mode must be one of create, import, skip.");
  }

  // Skip path (hub#168 Cut 2): module is already installed (init.ts
  // ran `install vault --no-create`); we just persist a flag that
  // `deriveWizardState` consults to skip the vault step on subsequent
  // GETs. No supervisor work, no op_id — runs without the supervisor.
  if (rawMode === "skip") {
    setSetting(deps.db, "setup_vault_skipped", "true");
    if (form.isJson) {
      return jsonOkResponse({ step: "expose", message: "vault step skipped" });
    }
    return redirect("/admin/setup");
  }

  // Operator picked create or import — if they previously skipped (in
  // another tab / via back button), the skip flag would still claim
  // "vault step done" even after the vault row appears. Clear it
  // defensively so `deriveWizardState` consults the real vault entry
  // going forward.
  deleteSetting(deps.db, "setup_vault_skipped");

  // Create / import paths need the supervisor — they spawn vault and
  // (for import) call vault's mirror endpoint. The CLI hub surface
  // doesn't wire a supervisor; operators are expected to use
  // `parachute install vault` directly there. Container/serve-mode
  // hub has one.
  if (!deps.supervisor) {
    if (form.isJson) {
      return jsonErrorResponse(
        503,
        "Module supervisor unavailable",
        "The wizard's create/import paths need container-mode `parachute serve` to spawn vault. " +
          "On the on-box CLI surface, run `parachute install vault` first, then re-run the wizard with --vault-mode skip.",
      );
    }
    return badRequestPage(
      "Module supervisor unavailable",
      "The first-boot wizard needs container-mode `parachute serve` to install modules. " +
        "On the on-box CLI surface, run `parachute install vault` directly.",
    );
  }

  // hub#267: the operator-typed vault name is now threaded all the way
  // through to vault's first-boot via `PARACHUTE_VAULT_NAME` (vault#342
  // shipped the env-var read in vault's `server.ts`). Empty input
  // falls back to the canonical `DEFAULT_VAULT_NAME` so the "just give
  // me a vault" path still works without typing anything.
  const csrfTokenStr = typeof formCsrf === "string" ? formCsrf : "";
  const rawName = String(form.get("vault_name") ?? "").trim();
  let vaultName: string;
  if (rawName === "") {
    vaultName = DEFAULT_VAULT_NAME;
  } else {
    const v = validateVaultName(rawName);
    if (!v.ok) {
      if (form.isJson) {
        return jsonErrorResponse(400, "Invalid vault name", v.error);
      }
      return htmlResponse(
        renderVaultStep({
          csrfToken: csrfTokenStr,
          vaultName: rawName,
          errorMessage: v.error,
        }),
        400,
      );
    }
    vaultName = v.name;
  }

  // Import path (hub#168 Cut 2): collect the remote URL + optional PAT
  // + replace flag up front so a malformed input fails fast before we
  // spawn the vault. The actual import POST to vault's
  // `/vault/<name>/.parachute/mirror/import` happens AFTER vault has
  // come up under the supervisor; the params are captured by closure
  // into the post-install `.then()` (see `importToRun` below).
  let importParams: { remoteUrl: string; pat?: string; mode: "merge" | "replace" } | undefined;
  if (rawMode === "import") {
    const remoteUrl = String(form.get("remote_url") ?? "").trim();
    if (remoteUrl === "") {
      if (form.isJson) {
        return jsonErrorResponse(
          400,
          "Remote URL required",
          'remote_url must be a non-empty HTTPS or SSH clone URL when mode="import".',
        );
      }
      return htmlResponse(
        renderVaultStep({
          csrfToken: csrfTokenStr,
          vaultName: rawName,
          errorMessage: "Remote URL is required to import a vault. Paste a git clone URL.",
        }),
        400,
      );
    }
    const importMode = String(form.get("import_mode") ?? "merge").trim();
    if (importMode !== "merge" && importMode !== "replace") {
      const err = `import_mode must be "merge" or "replace" (got "${importMode}").`;
      if (form.isJson) {
        return jsonErrorResponse(400, "Invalid import_mode", err);
      }
      return htmlResponse(
        renderVaultStep({ csrfToken: csrfTokenStr, vaultName: rawName, errorMessage: err }),
        400,
      );
    }
    const pat = String(form.get("pat") ?? "").trim();
    importParams = {
      remoteUrl,
      mode: importMode,
      ...(pat ? { pat } : {}),
    };
  }
  // Persist for the done-step renderer. Vault overwrites services.json
  // on its first authoritative boot, but until that completes the wizard
  // needs a stable source of truth for the typed name — both for the
  // op-poll page subtitle and the post-redirect done step.
  setSetting(deps.db, "setup_vault_name", vaultName);
  const registry = deps.registry;
  const vaultSpec = specFor(FIRST_VAULT_SHORT);

  // Idempotent short-circuit: if the supervisor is already running (or
  // mid-spawn) for vault — i.e. a previous POST already kicked off
  // `runInstall` and beat us to spawning — return a synthesized
  // succeeded op instead of firing a second `bun add -g`. Mirrors the
  // pattern in `handleInstall` (api-modules-ops.ts). Without this,
  // two concurrent POSTs both pass `state.hasVault === false` (the
  // services.json seed is the only signal that step exits, and it's
  // written by `runInstall` *after* `bun add` returns), and each
  // fires its own install — wasted work and a possible race on the
  // seed/spawn writes. Low risk on first-boot in practice, but the
  // fix is cheap and matches the API surface's posture.
  const supervisorState = deps.supervisor.get(FIRST_VAULT_SHORT);
  if (
    supervisorState?.status === "running" ||
    supervisorState?.status === "starting" ||
    supervisorState?.status === "restarting"
  ) {
    if (registry) {
      const op = registry.create("install", FIRST_VAULT_SHORT);
      registry.update(
        op.id,
        { status: "succeeded" },
        `${FIRST_VAULT_SHORT} already supervised (status=${supervisorState.status})`,
      );
      if (form.isJson) {
        return jsonOkResponse({ op_id: op.id, step: "vault", message: "vault already supervised" });
      }
      return redirect(`/admin/setup?op=${encodeURIComponent(op.id)}`);
    }
    if (form.isJson) {
      return jsonOkResponse({ step: "vault", message: "vault already supervised" });
    }
    return redirect("/admin/setup");
  }

  const op = registry
    ? registry.create("install", FIRST_VAULT_SHORT)
    : { id: cryptoRandomId(), status: "pending" as const, log: [] as string[] };
  if (registry) {
    // hub#267: thread the typed name through `PARACHUTE_VAULT_NAME` so
    // vault's first-boot path (vault#342) names the created vault
    // accordingly. Skip the env override when the operator left the
    // field blank — vault's `resolveFirstBootVaultName` defaults to
    // `default` on absent env vars, so this preserves the prior
    // behaviour for the empty-input case.
    //
    // If the operator typed "default" explicitly, treat the same as
    // blank — vault's first-boot defaults to "default" anyway, so
    // skipping the env override is correct (the comparison below
    // catches both blank-trimmed-to-DEFAULT and typed-"default").
    const spawnEnv: Record<string, string> = {};
    if (vaultName !== DEFAULT_VAULT_NAME) {
      spawnEnv.PARACHUTE_VAULT_NAME = vaultName;
    }
    // Capture importParams + deps in the runInstall promise chain — when
    // mode === "import", run the vault-side `/.parachute/mirror/import`
    // POST as a follow-up step once the supervised vault has come up
    // and confirmed healthy. The hub-side op_id stays the same so the
    // CLI / browser sees a single progress stream; we just append more
    // log lines while the import runs. On import error, the op is
    // marked failed so the caller surfaces a usable message.
    const importToRun = importParams;
    const vaultIssuer = deps.issuer;
    const importerUserId = session.userId;
    const vaultPort = vaultSpec.seedEntry?.().port ?? 1940;
    void runInstall(op.id, FIRST_VAULT_SHORT, vaultSpec, {
      db: deps.db,
      issuer: deps.issuer,
      manifestPath: deps.manifestPath,
      configDir: deps.configDir,
      supervisor: deps.supervisor,
      registry,
      ...(deps.run ? { run: deps.run } : {}),
      ...(deps.isLinked ? { isLinked: deps.isLinked } : {}),
      ...(Object.keys(spawnEnv).length > 0 ? { spawnEnv } : {}),
    })
      .then(async () => {
        if (!importToRun) return;
        const opState = registry.get(op.id);
        if (!opState || opState.status !== "succeeded") return;
        // Import is a follow-up step: mark op back to running, POST to
        // vault, surface the result in the op log.
        registry.update(
          op.id,
          { status: "running" },
          `vault up — starting import from ${importToRun.remoteUrl} (mode=${importToRun.mode})`,
        );
        try {
          // Mint a short-lived per-vault admin Bearer for the import POST.
          // Vault validates audience `vault.<name>` + scope `vault:<name>:admin`
          // (see admin-vault-admin-token.ts for the canonical shape — same
          // contract the SPA Manage link uses). The token only needs to
          // live until vault accepts the HTTP request (the clone itself
          // happens inside vault after the auth check passes); 5 min is
          // a generous safety net covering the supervisor's boot-grace
          // retries on a sluggish host. Deliberate divergence from the
          // SPA's 10-min TTL because this token is one-shot, not refreshed.
          const minted = await signAccessToken(deps.db, {
            sub: importerUserId,
            scopes: [`vault:${vaultName}:admin`],
            audience: `vault.${vaultName}`,
            clientId: "parachute-hub-setup-wizard",
            issuer: vaultIssuer,
            ttlSeconds: 5 * 60,
            vaultScope: [vaultName],
          });
          const result = await postVaultImportImpl({
            vaultName,
            vaultPort,
            bearerToken: minted.token,
            remoteUrl: importToRun.remoteUrl,
            mode: importToRun.mode,
            ...(importToRun.pat ? { pat: importToRun.pat } : {}),
          });
          registry.update(
            op.id,
            { status: "succeeded" },
            `import succeeded — notes_imported=${result.notes_imported ?? 0}, tags_imported=${
              result.tags_imported ?? 0
            }, attachments_imported=${result.attachments_imported ?? 0}`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          registry.update(op.id, { status: "failed", error: msg }, `import failed: ${msg}`);
        }
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        registry.update(op.id, { status: "failed", error: msg }, `install failed: ${msg}`);
      });
  } else {
    // No registry wired (test-only path; production always passes one).
    // Log a visible warning so future mis-wirings are debuggable —
    // silent swallow here would make the wizard appear to hang.
    console.warn(
      "[setup-wizard] handleSetupVaultPost called with no operations registry — install will NOT run. Wire deps.registry in the dispatcher.",
    );
  }
  // Scribe sub-form fold (2026-05-27). The vault step's form lets
  // the operator answer "do you also want voice transcription?" +
  // "do you also want LLM cleanup?" in the same submission. If they
  // asked for either, we (a) write the chosen provider(s) + API
  // key(s) to `~/.parachute/scribe/config.json` so scribe finds
  // them on first boot, and (b) kick a scribe install op in
  // parallel with vault install. The vault op-poll page threads the
  // scribe op_id through its success-redirect so the done step can
  // poll scribe progress via the existing per-tile mechanism.
  //
  // Cleanup-without-transcribe is a valid combo: the operator can
  // hit scribe's REST cleanup endpoint directly with their own raw
  // text. We install scribe + write the cleanup block in that case.
  let scribeProvider = String(form.get("scribe_provider") ?? "").trim();
  const scribeCleanupProvider = String(form.get("scribe_cleanup_provider") ?? "").trim();
  // RAM/platform gate: if the operator asked for `local` on a box that can't
  // run a local ASR model (no local backend for the platform, or too little
  // RAM — the 1 GB droplet would OOM), redirect the choice to a cloud provider
  // (groq) rather than recording a dead `local` string scribe can never honor.
  // The reason is logged; the inline UI surfaces it via the scribe op poll.
  if (scribeProvider === "local") {
    const decision = decideLocalProvider(process.platform, readAvailableRamMib());
    if (!decision.ok) {
      console.warn(
        `[setup-wizard] local transcription unavailable on this host: ${decision.reason} ` +
          `Steering to "${decision.steerTo}".`,
      );
      scribeProvider = decision.steerTo ?? "groq";
    }
  }
  const wantsTranscribe = scribeProvider !== "" && scribeProvider !== "none";
  const wantsCleanup = scribeCleanupProvider !== "" && scribeCleanupProvider !== "none";
  let scribeOpId: string | undefined;
  if (wantsTranscribe || wantsCleanup) {
    const scribeApiKey = String(form.get("scribe_api_key") ?? "").trim();
    const scribeCleanupApiKey = String(form.get("scribe_cleanup_api_key") ?? "").trim();
    // Write scribe config FIRST so scribe's first boot picks up the
    // provider(s) + key(s) without a second config edit. We don't
    // fail the wizard on a config-write error — log it + carry on;
    // scribe will boot with defaults + the operator can fix via
    // /scribe/admin.
    try {
      writeScribeConfigForWizard(deps.configDir, {
        ...(wantsTranscribe
          ? { transcribe: { provider: scribeProvider, apiKey: scribeApiKey } }
          : {}),
        ...(wantsCleanup
          ? { cleanup: { provider: scribeCleanupProvider, apiKey: scribeCleanupApiKey } }
          : {}),
      });
    } catch (err) {
      console.warn(
        `[setup-wizard] failed to write scribe config: ${err instanceof Error ? err.message : String(err)} — kicking install anyway, operator can configure later.`,
      );
    }
    // Kick scribe install in parallel. Don't block on it; the done
    // step's per-tile op-poll surfaces progress.
    if (registry) {
      const scribeSpec = specFor("scribe");
      const scribeOp = registry.create("install", "scribe");
      scribeOpId = scribeOp.id;
      void runInstall(scribeOp.id, "scribe", scribeSpec, {
        db: deps.db,
        issuer: deps.issuer,
        manifestPath: deps.manifestPath,
        configDir: deps.configDir,
        supervisor: deps.supervisor,
        registry,
        ...(deps.run ? { run: deps.run } : {}),
        ...(deps.isLinked ? { isLinked: deps.isLinked } : {}),
      }).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        registry.update(
          scribeOp.id,
          { status: "failed", error: msg },
          `scribe install failed: ${msg}`,
        );
      });
    }
  }
  const redirectUrl = scribeOpId
    ? `/admin/setup?op=${encodeURIComponent(op.id)}&op_scribe=${encodeURIComponent(scribeOpId)}`
    : `/admin/setup?op=${encodeURIComponent(op.id)}`;
  if (form.isJson) {
    return jsonOkResponse({
      op_id: op.id,
      ...(scribeOpId ? { scribe_op_id: scribeOpId } : {}),
      step: "vault",
      mode: rawMode,
    });
  }
  return redirect(redirectUrl);
}

/**
 * POST the wizard-collected import params to vault's
 * `/vault/<name>/.parachute/mirror/import` endpoint. The caller mints
 * the per-vault admin Bearer (see `signAccessToken` use in the
 * `runInstall().then(...)` block above) and passes it in; vault gates
 * the endpoint on `vault:<name>:admin` upstream. Returns vault's
 * structured response or throws with a usable message.
 *
 * Lives in setup-wizard.ts (not as a vault-internal helper) because
 * vault doesn't import hub-internal code; the import POST is naturally
 * the wizard's job — it's the only caller until vault ships its own
 * admin SPA flow. Shape mirrors vault#390's contract:
 *   POST /vault/<name>/.parachute/mirror/import
 *   { remote_url, mode: "merge"|"replace", credentials: {kind, token}|null }
 *   200 { notes_imported, tags_imported, attachments_imported, warnings }
 *
 * Exported (with the `Impl` suffix) so tests can inject a stub fetcher
 * and assert the Authorization header without standing up a real vault.
 */
export async function postVaultImportImpl(args: {
  vaultName: string;
  vaultPort: number;
  bearerToken: string;
  remoteUrl: string;
  mode: "merge" | "replace";
  pat?: string;
  fetcher?: typeof fetch;
}): Promise<{
  notes_imported?: number;
  tags_imported?: number;
  attachments_imported?: number;
  warnings?: readonly string[];
}> {
  const fetcher = args.fetcher ?? fetch;
  // Vault listens on its supervised port — talk directly to 127.0.0.1
  // rather than going through hub's path-routing proxy. Cuts one
  // network hop and avoids the operator-session/CSRF dance.
  const url = `http://127.0.0.1:${args.vaultPort}/vault/${encodeURIComponent(args.vaultName)}/.parachute/mirror/import`;
  const body: Record<string, unknown> = {
    remote_url: args.remoteUrl,
    mode: args.mode,
  };
  if (args.pat) {
    body.credentials = { kind: "pat", token: args.pat };
  } else {
    body.credentials = null;
  }
  // Best-effort retry — the supervisor's `start` returns before vault
  // accepts traffic; a tiny grace window covers the boot lag without
  // a tight poll loop. Three attempts spaced 1s apart.
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetcher(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Vault's `authenticateVaultRequest` rejects 401 before scope
          // check when no Bearer is present. The token must carry
          // `vault:<name>:admin` + audience `vault.<name>` — minted at
          // the call site via `signAccessToken` so this function stays
          // pure (no db / userId capture).
          authorization: `Bearer ${args.bearerToken}`,
        },
        body: JSON.stringify(body),
      });
      if (res.status === 200) {
        return (await res.json()) as Awaited<ReturnType<typeof postVaultImportImpl>>;
      }
      // Vault returns structured JSON errors per mirror-routes.ts:
      // 400 (validation), 409 (concurrent), 502 (clone failed), 500.
      const errBody = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      throw new Error(
        `vault import returned ${res.status}: ${errBody.message ?? errBody.error ?? "unknown"}`,
      );
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      // ECONNREFUSED / fetch failure → vault hasn't bound yet. Retry.
      if (lastErr.message.includes("ECONNREFUSED") || lastErr.message.includes("Failed to fetch")) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr ?? new Error("vault import: exhausted retries");
}

/**
 * Write a minimal scribe config that selects the operator's chosen
 * transcribe + cleanup providers + API keys (when applicable).
 * Idempotent: reads any existing config, merges, writes back. File
 * mode 0o600 — the config holds API keys, owner-only.
 *
 * Lives in setup-wizard.ts (not scribe's own config-write.ts) because
 * (a) it's a one-time wizard write — the SPA's PUT /.parachute/config
 * surface is the canonical post-setup path, and (b) hub doesn't
 * import scribe-internal modules. The shape of `scribe-config.json`
 * is documented in parachute-scribe/src/config.ts; the fields we set
 * (`transcribe.provider`, `transcribeProviders.<name>.apiKey`,
 * `cleanup.provider`, `cleanup.default`, `cleanupProviders.<name>.apiKey`)
 * are stable. Cleanup block extended 2026-05-27 — scribe boots with
 * `cleanup: none` otherwise, so first-install operators got "raw
 * transcript only" until they hand-edited the config.
 *
 * Signature changed 2026-05-27 from `(configDir, provider, apiKey)` to
 * the options-object shape so the caller can express "cleanup only,
 * no transcribe" without smuggling sentinel strings.
 */
interface WizardScribeConfig {
  /** Set when the operator chose a transcription provider (anything other than "none"). */
  transcribe?: { provider: string; apiKey: string };
  /** Set when the operator chose a cleanup provider (anything other than "none"). */
  cleanup?: { provider: string; apiKey: string };
  /**
   * Platform override for resolving the `local` choice (test seam). Defaults to
   * the real host platform. Mac → parakeet-mlx, Linux → onnx-asr.
   */
  platform?: NodeJS.Platform;
}
function writeScribeConfigForWizard(configDir: string, config: WizardScribeConfig): void {
  const update: Record<string, unknown> = {};
  const platform = config.platform ?? process.platform;

  if (config.transcribe) {
    const { provider, apiKey } = config.transcribe;
    // For `local`, resolve to the CORRECT platform backend — parakeet-mlx on
    // macOS, onnx-asr on Linux. (Was hardcoded to parakeet-mlx, which silently
    // fails on every Linux box.) No key needed for local. The caller's
    // RAM/platform gate is the single place that decides "local isn't possible
    // here" and should have steered to cloud before reaching this writer — but
    // if that gate is ever bypassed and the platform has no local backend, we
    // write "none" (transcription off) rather than a dead provider string, so
    // this writer can never record something that silently fails.
    if (provider === "local") {
      const resolved = platformLocalProvider(platform);
      update.transcribe = { provider: resolved ?? "none" };
    } else {
      // Cloud providers need a key. Empty key → just set provider;
      // the operator can paste the key later via /scribe/admin
      // without a restart (per provider-config.ts's per-request
      // precedence).
      update.transcribe = { provider };
      if (apiKey !== "") {
        update.transcribeProviders = { [provider]: { apiKey } };
      }
    }
  }

  if (config.cleanup) {
    const { provider, apiKey } = config.cleanup;
    // Always set `cleanup.default: true` when the operator opted in to
    // cleanup — they want polished output as the default; the per-
    // request `cleanup` flag on each transcribe request can still
    // opt out individually.
    update.cleanup = { provider, default: true };
    // `claude-code` (host CLI auth) and `ollama` (local server)
    // don't need an API key. Everything else (anthropic, openai,
    // groq, gemini) takes a key. Empty key → just set the provider;
    // the operator can paste the key later via the admin SPA without
    // a restart.
    const needsKey = provider !== "claude-code" && provider !== "ollama";
    if (needsKey && apiKey !== "") {
      update.cleanupProviders = { [provider]: { apiKey } };
    }
  }

  if (Object.keys(update).length === 0) return;
  persistScribeConfig(configDir, update);
}

/**
 * Merge-write to scribe's config file at `<configDir>/scribe/config.json`.
 * Reads existing JSON when present, deep-merges `update`, writes back at
 * mode 0o600. Creates the parent dir if missing.
 */
function persistScribeConfig(configDir: string, update: Record<string, unknown>): void {
  const scribeDir = join(configDir, "scribe");
  const configPath = join(scribeDir, "config.json");
  mkdirSync(scribeDir, { recursive: true });
  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    } catch {
      // Malformed existing config — treat as empty + overwrite.
      existing = {};
    }
  }
  // Shallow merge at top level, deep merge for the sub-blocks we touch
  // (transcribe + transcribeProviders + cleanup + cleanupProviders). The
  // merge logic is generic and handles any nested object — it doesn't
  // hard-code the block names.
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(update)) {
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof merged[key] === "object" &&
      merged[key] !== null &&
      !Array.isArray(merged[key])
    ) {
      merged[key] = { ...(merged[key] as Record<string, unknown>), ...value };
    } else {
      merged[key] = value;
    }
  }
  writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
}

/**
 * POST `/admin/setup/expose`. Form-encoded.
 *
 * Persists the operator's "how will this hub be reached?" answer to
 * `hub_settings.setup_expose_mode` (hub#268 Item 2). Three valid values:
 * `localhost`, `tailnet`, `public`.
 *
 * This is also the transition where the wizard considers itself "done"
 * for the auto-approve-first-client feature (hub#268 Item 3): we open a
 * 60-minute window where the next OAuth client registration is
 * auto-approved. Reasoning lives in `hub-settings.ts`; the wizard just
 * fires it on the only event that means "operator just finished the
 * canonical onboarding."
 *
 * Gated on an admin session cookie like the vault POST is — same shape,
 * same reason.
 */
export async function handleSetupExposePost(
  req: Request,
  deps: SetupWizardDeps,
): Promise<Response> {
  const form = await readBodyFields(req);
  const formCsrf = form.get(CSRF_FIELD_NAME);
  if (!verifyCsrfToken(req, typeof formCsrf === "string" ? formCsrf : null)) {
    if (form.isJson) {
      return jsonErrorResponse(400, "Invalid form submission", "Reload and try again.");
    }
    return badRequestPage("Invalid form submission", "Reload and try again.");
  }
  const session = findActiveSession(deps.db, req);
  if (!session) {
    if (form.isJson) {
      return jsonErrorResponse(401, "No admin session", "Sign in to continue setup.");
    }
    return badRequestPage(
      "No admin session",
      "Sign in to continue setup. (The wizard sets a session cookie on step 2; clearing cookies between steps will land you here.)",
    );
  }
  // Already done — short-circuit to the success screen. Belt-and-braces:
  // the wizard's GET shape catches this case too, but a direct POST
  // (curl, tab race) shouldn't double-fire the auto-approve window.
  if (getSetting(deps.db, "setup_expose_mode") !== undefined) {
    if (form.isJson) {
      return jsonOkResponse({ step: "done", message: "expose mode already set" });
    }
    return redirect("/admin/setup?just_finished=1");
  }
  const rawMode = form.get("expose_mode");
  if (!isSetupExposeMode(rawMode)) {
    if (form.isJson) {
      return jsonErrorResponse(
        400,
        "Invalid expose_mode",
        `Pick one of: ${SETUP_EXPOSE_MODES.join(", ")}.`,
      );
    }
    return htmlResponse(
      renderExposeStep({
        csrfToken: typeof formCsrf === "string" ? formCsrf : "",
        errorMessage: `Pick one of: ${SETUP_EXPOSE_MODES.join(", ")}.`,
      }),
      400,
    );
  }
  setSetting(deps.db, "setup_expose_mode", rawMode);
  // hub#268 Item 3: open the 60-minute auto-approve window for the first
  // OAuth client registration. Logged so an operator chasing odd behavior
  // can see it fired.
  openFirstClientAutoApproveWindow(deps.db);
  console.log(
    `[setup-wizard] opened first-client auto-approve window (60min) after expose-mode=${rawMode}`,
  );
  // hub#272 Item A USED to auto-mint a broad `admin`-scope operator token
  // here + stash it (`setup_minted_token`) so the done screen could
  // pre-fill the MCP install command with a `--header "Authorization:
  // Bearer <token>"` flag. Removed 2026-06-23 (Austen's report): vault/
  // init is OAuth-default now (parachute-vault #491), so the bare
  // `claude mcp add` command is the correct UX — it triggers browser
  // OAuth on first use. Baking a full admin-scope bearer into a copy-
  // pasted command was both the wrong default and a privilege over-grant
  // (a single shoulder-surf / screencast leaked an admin token). The
  // done step now always renders the bare OAuth command; headless
  // clients that can't do the browser flow mint a scoped token at
  // /admin/tokens + append the header themselves (the bare tile points
  // there). No token is minted or stored by default.
  if (form.isJson) {
    return jsonOkResponse({
      step: "done",
      message: "expose mode set",
    });
  }
  return redirect("/admin/setup?just_finished=1");
}

// --- step 5 helpers: install tiles --------------------------------------

/**
 * Curated module short → display props rendered on the done-screen
 * install tiles. Order matters — list order is render order. Vault is
 * intentionally excluded (the wizard already provisioned it).
 *
 * `tagline` mirrors each module's `displayName + tagline` from
 * `FIRST_PARTY_FALLBACKS` (`src/service-spec.ts`); kept verbatim here
 * so the wizard isn't coupled to service-spec internals.
 */
const INSTALL_TILE_PROPS: ReadonlyArray<{
  short: CuratedModuleShort;
  displayName: string;
  tagline: string;
}> = [
  {
    short: "scribe",
    displayName: "Scribe",
    tagline: "Local audio transcription for vault recordings.",
  },
];

/**
 * Construct the install-tile state array for the done step. Reads the
 * URL's `?op_<short>=<id>` query (per-module op-poll), the services.json
 * manifest (already-installed detection), and the operations registry
 * (op status snapshot). Pure-ish — only the registry call is impure.
 */
function buildInstallTiles(url: URL, deps: SetupWizardDeps): ModuleInstallTileState[] {
  const manifest = readManifestLenient(deps.manifestPath);
  return INSTALL_TILE_PROPS.filter((p) =>
    (CURATED_MODULES as readonly string[]).includes(p.short),
  ).map((p) => {
    const spec = specFor(p.short);
    const alreadyInstalled = manifest.services.some((s) => s.name === spec.manifestName);
    const tile: ModuleInstallTileState = {
      short: p.short,
      displayName: p.displayName,
      tagline: p.tagline,
      alreadyInstalled,
    };
    const opId = url.searchParams.get(`op_${p.short}`);
    if (opId && deps.registry) {
      const op = deps.registry.get(opId);
      if (op) {
        tile.operation = {
          id: op.id,
          status: op.status,
          log: op.log,
          ...(op.error !== undefined ? { error: op.error } : {}),
        };
      }
    }
    return tile;
  });
}

/**
 * POST `/admin/setup/install/<short>`. Form-encoded, session-gated.
 *
 * Kicks off the same `runInstall` pipeline `/api/modules/<short>/install`
 * uses (hub#260) but from the wizard's session-cookie surface — no
 * separate bearer mint dance for the operator who just finished the
 * wizard.
 *
 * Returns 303 to `/admin/setup?just_finished=1&op_<short>=<opId>` so
 * the done-screen renderer picks up the op via `buildInstallTiles`.
 * Multiple in-flight installs are supported (query keeps `op_<short>`
 * per module); the auto-refresh meta keeps polling while any module
 * is pending/running.
 *
 * Rejects when:
 *   * `short` isn't a curated module short
 *   * `short === "vault"` — the wizard's vault step owns that
 *   * session cookie missing
 *   * CSRF token missing or wrong
 *   * supervisor isn't wired (CLI-mode hub)
 */
export async function handleSetupInstallPost(
  req: Request,
  short: string,
  deps: SetupWizardDeps,
): Promise<Response> {
  if (!deps.supervisor) {
    return badRequestPage(
      "Module supervisor unavailable",
      `Module installs from the wizard require container-mode \`parachute serve\`. On the on-box CLI surface, run \`parachute install ${short}\` directly.`,
    );
  }
  if (!(CURATED_MODULES as readonly string[]).includes(short) || short === "vault") {
    return badRequestPage(
      "Unknown module",
      `"${short}" is not an installable wizard module. Pick from the done-screen tiles.`,
    );
  }
  const form = await req.formData();
  const formCsrf = form.get(CSRF_FIELD_NAME);
  if (!verifyCsrfToken(req, typeof formCsrf === "string" ? formCsrf : null)) {
    return badRequestPage("Invalid form submission", "Reload and try again.");
  }
  const session = findActiveSession(deps.db, req);
  if (!session) {
    return badRequestPage(
      "No admin session",
      "Sign in to continue. The wizard's session cookie was set at step 2; clearing cookies between steps lands you here.",
    );
  }
  const moduleShort = short as CuratedModuleShort;
  const spec = specFor(moduleShort);
  const registry = deps.registry;
  // Idempotent short-circuit: if already supervised + running, return a
  // synthesized succeeded op rather than firing a second `bun add`.
  // Mirrors `handleSetupVaultPost` + `handleInstall`.
  const supervisorState = deps.supervisor.get(moduleShort);
  if (
    supervisorState?.status === "running" ||
    supervisorState?.status === "starting" ||
    supervisorState?.status === "restarting"
  ) {
    if (registry) {
      const op = registry.create("install", moduleShort);
      registry.update(
        op.id,
        { status: "succeeded" },
        `${moduleShort} already supervised (status=${supervisorState.status})`,
      );
      return redirect(
        `/admin/setup?just_finished=1&op_${moduleShort}=${encodeURIComponent(op.id)}`,
      );
    }
    return redirect("/admin/setup?just_finished=1");
  }
  const op = registry
    ? registry.create("install", moduleShort)
    : { id: cryptoRandomId(), status: "pending" as const, log: [] as string[] };
  if (registry) {
    void runInstall(op.id, moduleShort, spec, {
      db: deps.db,
      issuer: deps.issuer,
      manifestPath: deps.manifestPath,
      configDir: deps.configDir,
      supervisor: deps.supervisor,
      registry,
      ...(deps.run ? { run: deps.run } : {}),
      ...(deps.isLinked ? { isLinked: deps.isLinked } : {}),
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      registry.update(op.id, { status: "failed", error: msg }, `install failed: ${msg}`);
    });
  } else {
    console.warn(
      "[setup-wizard] handleSetupInstallPost called with no operations registry — install will NOT run. Wire deps.registry in the dispatcher.",
    );
  }
  return redirect(`/admin/setup?just_finished=1&op_${moduleShort}=${encodeURIComponent(op.id)}`);
}

// --- helpers ------------------------------------------------------------

function validateAccountFields(input: {
  username: string;
  password: string;
  confirm: string;
}): string | undefined {
  if (input.username.length < 2 || input.username.length > 64) {
    return "Username must be 2–64 characters.";
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(input.username)) {
    return "Username may use letters, digits, underscore, period, hyphen.";
  }
  if (input.password.length < 8) {
    return "Password must be at least 8 characters.";
  }
  if (input.password !== input.confirm) {
    return "Passwords do not match.";
  }
  return undefined;
}

/**
 * Whether a given curated module is currently installed (has a row in
 * services.json keyed by its canonical `manifestName`). Used by
 * `buildInstallTiles` to decide whether an install-tile row renders
 * the "install" form or the "already installed" state. Cheap manifest
 * read (no network).
 */
function isModuleInstalled(short: CuratedModuleShort, manifestPath: string): boolean {
  const manifest = readManifestLenient(manifestPath);
  const spec = specFor(short);
  return manifest.services.some((s) => s.name === spec.manifestName);
}

/**
 * Read the first vault's display name from services.json. Returns
 * null when services.json has no vault entry or the entry has no
 * `/vault/<name>` path — used by the done step to detect "no live
 * vault, fall back to the operator-typed value." Distinguishing
 * "no live vault" from "live vault named default" matters: the
 * former should defer to the DB-cached name; the latter should
 * win over a possibly-stale DB cache (smoke 2026-05-27 finding 2).
 */
function firstVaultNameOrNull(manifestPath: string): string | null {
  const manifest = readManifestLenient(manifestPath);
  // Match on the canonical vault manifestName from the curated spec.
  // (`CURATED_MODULES.includes("vault")` was a dead guard — vault is a
  // tuple-literal member, so the conjunct is always true.)
  const entry = manifest.services.find((s) => s.name === specFor("vault").manifestName);
  if (!entry) return null;
  // services.json entries store the mount path (e.g. `/vault/default`).
  // Strip the canonical prefix to surface the display name.
  for (const p of entry.paths ?? []) {
    if (p.startsWith("/vault/")) {
      const tail = p.slice("/vault/".length).replace(/\/+$/, "");
      if (tail.length > 0) return tail;
    }
  }
  return null;
}

function htmlResponse(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...extra },
  });
}

function redirect(location: string, extra: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { location, ...extra } });
}

/**
 * Structured JSON-200 helper for the CLI wizard surface (hub#168 Cut 3).
 * Mirrors the browser-redirect responses' header shape (extra cookies
 * pass through) without the 303 status that would force the CLI's
 * `fetch` to chase a non-existent location.
 */
function jsonOkResponse(body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}

/**
 * Structured JSON-error helper for the CLI wizard surface (hub#168 Cut 3).
 * The browser path renders a full HTML error page; the CLI wants a
 * machine-parseable envelope with the same fields the rendered page
 * shows. Status code is the same as the HTML branch (400/401/410/etc).
 */
function jsonErrorResponse(status: number, title: string, message: string): Response {
  return new Response(JSON.stringify({ error: title, message, status }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function badRequestPage(title: string, message: string): Response {
  return htmlResponse(renderBadRequestPage(title, message), 400);
}

function renderBadRequestPage(title: string, message: string): string {
  const body = `
    <div class="card">
      ${header("welcome")}
      <h1 class="error-title">${escapeHtml(title)}</h1>
      <p class="subtitle">${escapeHtml(message)}</p>
      <p><a class="btn btn-primary" href="/admin/setup">Restart setup</a></p>
    </div>`;
  return baseDocument(title, body);
}

/**
 * Fallback op id when no registry is wired — the wizard's UX still
 * needs *something* to redirect to so the page doesn't hang. The
 * redirect's `op` query then resolves to "no op found," which renders
 * the bare step-3 form again. Production callers always pass a
 * registry (the dispatcher in `hub-server.ts` plugs in
 * `getDefaultOperationsRegistry()`); this branch is exercised only by
 * tests that deliberately omit it. `handleSetupVaultPost` logs a
 * `console.warn` when it takes this branch so a real-world
 * mis-wiring surfaces in the operator's logs instead of silently
 * swallowing the install.
 */
function cryptoRandomId(): string {
  return `op-${Math.random().toString(36).slice(2, 10)}`;
}

// --- styles -------------------------------------------------------------

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
    max-width: 38rem;
    background: ${PALETTE.cardBg};
    border: 1px solid ${PALETTE.border};
    border-radius: 12px;
    padding: 2rem 1.75rem;
    box-shadow: 0 1px 2px rgba(44, 42, 38, 0.04), 0 8px 24px rgba(44, 42, 38, 0.06);
  }
  .card-header { margin-bottom: 1.25rem; }
  .brand {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: ${PALETTE.accent};
    font-weight: 500;
    font-size: 0.95rem;
    margin-bottom: 0.5rem;
  }
  .brand-mark { display: inline-flex; line-height: 0; }
  .brand-mark svg { width: 20px; height: 20px; }
  .brand-name { letter-spacing: 0.01em; }
  .brand-tag {
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-size: 0.7rem;
    color: ${PALETTE.fgMuted};
    border: 1px solid ${PALETTE.borderLight};
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
  }
  .steps {
    list-style: none;
    padding: 0;
    margin: 0 0 1rem;
    display: flex;
    gap: 0.4rem;
    font-size: 0.8rem;
    color: ${PALETTE.fgDim};
    flex-wrap: wrap;
  }
  .step {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }
  .step + .step::before {
    content: "→";
    color: ${PALETTE.fgDim};
    margin-right: 0.2rem;
  }
  .step-marker {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 999px;
    background: ${PALETTE.borderLight};
    color: ${PALETTE.fgMuted};
    font-size: 0.7rem;
    font-family: ${FONT_MONO};
  }
  .step.current .step-marker {
    background: ${PALETTE.accent};
    color: ${PALETTE.cardBg};
  }
  .step.past .step-marker {
    background: ${PALETTE.success};
    color: ${PALETTE.cardBg};
  }
  .step.current .step-label { color: ${PALETTE.fg}; font-weight: 500; }
  h1 {
    font-family: ${FONT_SERIF};
    font-weight: 400;
    font-size: 1.75rem;
    line-height: 1.2;
    margin: 0 0 0.4rem;
    color: ${PALETTE.fg};
  }
  h2 {
    font-family: ${FONT_SANS};
    font-size: 0.85rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: ${PALETTE.fgMuted};
    margin: 1.25rem 0 0.4rem;
  }
  .subtitle { margin: 0 0 0.5rem; color: ${PALETTE.fgMuted}; font-size: 0.95rem; }
  .explainer {
    background: ${PALETTE.accentSoft};
    border: 1px solid ${PALETTE.borderLight};
    border-radius: 8px;
    padding: 0.5rem 1rem;
    margin: 1rem 0 1.25rem;
    font-size: 0.92rem;
  }
  .explainer h2 { margin-top: 0.75rem; }
  .explainer p { margin: 0 0 0.5rem; }
  .preview {
    margin: 1rem 0;
  }
  .preview-label {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: ${PALETTE.fgMuted};
    margin: 0 0 0.25rem;
  }
  .preview-card {
    background: ${PALETTE.warnSoft};
    border-left: 3px solid ${PALETTE.warn};
    padding: 0.6rem 0.9rem;
    border-radius: 0 6px 6px 0;
    font-family: ${FONT_MONO};
    font-size: 0.9rem;
  }
  .preview-key { color: ${PALETTE.fgMuted}; }
  .preview-val { font-weight: 600; color: ${PALETTE.fg}; }
  .preview-fine { color: ${PALETTE.fgMuted}; font-size: 0.85em; }

  .auth-form { display: flex; flex-direction: column; gap: 0.9rem; }
  .field { display: flex; flex-direction: column; gap: 0.35rem; }
  .field-label {
    font-size: 0.85rem;
    font-weight: 500;
    color: ${PALETTE.fgMuted};
    letter-spacing: 0.01em;
    font-family: ${FONT_MONO};
  }
  .field-hint {
    font-size: 0.78rem;
    color: ${PALETTE.fgDim};
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
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .btn-primary {
    background: ${PALETTE.accent};
    color: ${PALETTE.cardBg};
    margin-top: 0.4rem;
  }
  .btn-primary:hover { background: ${PALETTE.accentHover}; }
  .btn-secondary {
    background: transparent;
    color: ${PALETTE.accent};
    border-color: ${PALETTE.accent};
  }
  .btn-secondary:hover {
    background: ${PALETTE.accentSoft};
  }
  /* Install-tile section (hub#272 Item B). Lives above the .done-grid;
     primary "what's next?" surface. Tiles render in a responsive grid
     that collapses to one column on narrow viewports. */
  .install-tiles {
    margin: 1rem 0 1.25rem;
  }
  .install-tiles-heading {
    margin: 0 0 0.25rem;
    text-transform: none;
    letter-spacing: 0;
    font-size: 1.05rem;
    color: ${PALETTE.fg};
  }
  .install-tiles-subtitle {
    margin: 0 0 0.75rem;
    color: ${PALETTE.fgMuted};
    font-size: 0.9rem;
  }
  .install-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.75rem;
  }
  @media (min-width: 30rem) {
    .install-grid { grid-template-columns: 1fr 1fr; }
  }
  .install-tile {
    border: 1px solid ${PALETTE.borderLight};
    border-radius: 8px;
    padding: 0.75rem 0.9rem;
    background: ${PALETTE.cardBg};
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    /* min-width: 0 lets the grid track shrink below the tile's intrinsic
       content width — without it a long log line in .install-tile-log
       forces the tile (and its parent grid track) wider than the card,
       which is what stretched the wizard when Aaron clicked Install App. */
    min-width: 0;
  }
  /* "Use it now" action row on a successful install-tile (hub#342 item 3). */
  .install-tile-actions {
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .install-tile h3 {
    margin: 0;
    font-family: ${FONT_SERIF};
    font-weight: 400;
    font-size: 1.1rem;
    color: ${PALETTE.fg};
  }
  .install-tile-tagline {
    margin: 0;
    color: ${PALETTE.fgMuted};
    font-size: 0.85rem;
  }
  .install-tile-form {
    margin: 0;
  }
  .install-tile-installed {
    background: ${PALETTE.accentSoft};
    border-color: ${PALETTE.accent};
  }
  .install-tile-status {
    margin: 0;
    color: ${PALETTE.success};
    font-weight: 500;
    font-size: 0.85rem;
  }
  .install-tile-running, .install-tile-pending {
    border-color: ${PALETTE.warn};
  }
  .install-tile-succeeded {
    background: ${PALETTE.accentSoft};
    border-color: ${PALETTE.accent};
  }
  .install-tile-failed {
    border-color: ${PALETTE.danger};
    background: ${PALETTE.dangerSoft};
  }
  .install-tile-log {
    margin: 0;
    font-size: 0.78rem;
  }
  .alt-path {
    margin-top: 1.25rem;
    border-top: 1px solid ${PALETTE.borderLight};
    padding-top: 0.75rem;
    font-size: 0.88rem;
    color: ${PALETTE.fgMuted};
  }
  .alt-path summary {
    cursor: pointer;
    font-weight: 500;
    color: ${PALETTE.fgMuted};
  }
  .alt-path p { margin: 0.5rem 0 0; }

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

  .bootstrap-callout {
    background: ${PALETTE.warnSoft};
    border-left: 3px solid ${PALETTE.warn};
    border-radius: 0 6px 6px 0;
    padding: 0.7rem 0.9rem;
    margin: 0 0 1rem;
    font-size: 0.9rem;
    color: ${PALETTE.fg};
  }
  .bootstrap-callout strong { color: ${PALETTE.fg}; }

  .op-log {
    background: ${PALETTE.bg};
    border: 1px solid ${PALETTE.borderLight};
    border-radius: 8px;
    padding: 0.75rem 1rem;
    margin: 1rem 0;
    font-family: ${FONT_MONO};
    font-size: 0.85rem;
    /* Install logs spit long lines (npm package names with paths, JSON
       dumps, stack traces). Without these constraints the <li> contents
       overflow the card horizontally — caught Aaron mid-install (hub#342):
       clicking Install App / Install Scribe blew up the entire wizard
       layout, font size jumped, the page stretched off-screen. The
       triple of overflow-x:auto + white-space:pre-wrap + min-width:0
       keeps the log inside its container regardless of line length:
       overflow-x:auto on .op-log gives a horizontal scrollbar as a
       last-resort affordance; pre-wrap on .log-lines li wraps cleanly
       at whitespace so the common case never even needs to scroll;
       min-width:0 on the outer log-lines list is the magic-flex bit
       that lets the list itself shrink below its content's intrinsic
       width inside the card's flex/grid layout. break-word (rather
       than break-all) keeps URLs / paths legible when they DO have to
       break. */
    overflow-x: auto;
    max-width: 100%;
  }
  .op-status {
    margin: 0 0 0.5rem;
    font-weight: 600;
    color: ${PALETTE.fgMuted};
  }
  .op-succeeded { color: ${PALETTE.success}; }
  .op-failed { color: ${PALETTE.danger}; }
  .log-lines {
    margin: 0;
    padding-left: 1.25rem;
    color: ${PALETTE.fgMuted};
    min-width: 0;
  }
  .log-lines li {
    margin: 0.15rem 0;
    white-space: pre-wrap;
    word-break: break-word;
    overflow-wrap: anywhere;
  }

  .done-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 1rem;
    margin: 1rem 0;
  }
  @media (min-width: 36rem) {
    .done-grid { grid-template-columns: 1fr 1fr; }
  }
  .done-tile {
    border: 1px solid ${PALETTE.borderLight};
    border-radius: 8px;
    padding: 0.75rem 1rem;
  }
  .done-tile h2 {
    margin-top: 0;
    text-transform: none;
    letter-spacing: 0;
    font-size: 1.05rem;
    color: ${PALETTE.fg};
  }
  .done-tile pre {
    background: ${PALETTE.bg};
    border: 1px solid ${PALETTE.borderLight};
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    overflow-x: auto;
    font-size: 0.82rem;
    margin: 0.5rem 0;
  }
  .done-tile .fine { font-size: 0.85rem; color: ${PALETTE.fgMuted}; }

  /* Vault-mode picker (hub#168 Cut 2). Three-option radio block at the
     top of the vault step, plus a collapsible import-only sub-form
     below. Shape mirrors .expose-option for visual consistency. */
  .vault-mode-block, .vault-import-block {
    border: 1px solid ${PALETTE.border};
    border-radius: 8px;
    padding: 0.75rem 0.9rem;
    margin: 0.4rem 0;
    background: ${PALETTE.cardBg};
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .vault-mode-block legend, .vault-import-block legend {
    padding: 0 0.4rem;
    font-size: 0.85rem;
    color: ${PALETTE.fgMuted};
    font-family: ${FONT_MONO};
  }
  .vault-mode-option {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    padding: 0.6rem 0.8rem;
    border: 1px solid ${PALETTE.borderLight};
    border-radius: 6px;
    cursor: pointer;
    transition: border-color 0.15s ease, background 0.15s ease;
  }
  .vault-mode-option:hover { border-color: ${PALETTE.accent}; }
  .vault-mode-option input[type=radio] {
    margin-top: 0.25rem;
    accent-color: ${PALETTE.accent};
    flex-shrink: 0;
  }
  .vault-mode-title {
    font-weight: 600;
    color: ${PALETTE.fg};
    font-size: 0.95rem;
    margin-left: 0.3rem;
  }
  .vault-mode-desc {
    color: ${PALETTE.fgMuted};
    font-size: 0.85rem;
    line-height: 1.45;
    flex-basis: 100%;
    margin-left: 1.7rem;
  }

  /* expose step (hub#268 Item 2). Vertical stack of radio cards;
     each label is the full clickable hit target. */
  .expose-form { gap: 0.65rem; }
  .expose-option {
    display: flex;
    align-items: flex-start;
    gap: 0.65rem;
    padding: 0.85rem 1rem;
    border: 1px solid ${PALETTE.border};
    border-radius: 8px;
    cursor: pointer;
    transition: border-color 0.15s ease, background 0.15s ease;
    background: ${PALETTE.cardBg};
  }
  .expose-option:hover { border-color: ${PALETTE.accent}; }
  .expose-option input[type=radio] {
    margin-top: 0.25rem;
    accent-color: ${PALETTE.accent};
    flex-shrink: 0;
  }
  .expose-option-body {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }
  .expose-option-title {
    font-weight: 600;
    color: ${PALETTE.fg};
    font-size: 0.95rem;
  }
  .expose-option-desc {
    color: ${PALETTE.fgMuted};
    font-size: 0.88rem;
    line-height: 1.45;
  }
  .expose-option-cmd {
    background: ${PALETTE.bg};
    border: 1px solid ${PALETTE.borderLight};
    border-radius: 6px;
    padding: 0.4rem 0.6rem;
    font-family: ${FONT_MONO};
    font-size: 0.82rem;
    margin: 0.25rem 0;
    overflow-x: auto;
  }

  /* reachable tile on the done step. Lives outside the .done-grid so it
     spans the full width — the URL itself is the headline. */
  .reachable {
    background: ${PALETTE.accentSoft};
    border-left: 3px solid ${PALETTE.accent};
    border-radius: 0 8px 8px 0;
    padding: 0.75rem 1rem;
    margin: 0 0 1rem;
  }
  .reachable h2 {
    margin: 0 0 0.4rem;
    text-transform: none;
    letter-spacing: 0;
    font-size: 0.9rem;
    color: ${PALETTE.accent};
  }
  .reachable-url {
    margin: 0.2rem 0;
    font-size: 0.95rem;
  }
  .reachable-url code {
    background: ${PALETTE.cardBg};
    border: 1px solid ${PALETTE.borderLight};
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
  }
  .reachable pre {
    background: ${PALETTE.cardBg};
    border: 1px solid ${PALETTE.borderLight};
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    overflow-x: auto;
    font-size: 0.82rem;
    margin: 0.4rem 0;
  }
  .reachable .fine { font-size: 0.85rem; color: ${PALETTE.fgMuted}; margin: 0.4rem 0 0; }

  /* "Start using your vault" lead tile on the done step (hub#342).
     Same visual weight as .reachable so the operator's eye lands here
     as the primary user-facing entry — slightly more prominent
     padding + a stronger heading to telegraph "this is the click
     you're looking for." */
  .start-using {
    background: ${PALETTE.cardBg};
    border: 1px solid ${PALETTE.accent};
    border-radius: 8px;
    padding: 1rem 1.1rem;
    margin: 0 0 1rem;
  }
  .start-using h2 {
    margin: 0 0 0.5rem;
    text-transform: none;
    letter-spacing: 0;
    font-size: 1.1rem;
    color: ${PALETTE.fg};
    font-family: ${FONT_SERIF};
    font-weight: 400;
  }
  .start-using p { margin: 0.4rem 0; }
  .start-using p:last-child { margin-bottom: 0; }

  code {
    background: ${PALETTE.borderLight};
    padding: 0.05rem 0.3rem;
    border-radius: 4px;
    font-family: ${FONT_MONO};
    font-size: 0.92em;
  }
  pre code {
    background: transparent;
    padding: 0;
  }

  @media (max-width: 480px) {
    main { padding: 0.75rem; }
    .card { padding: 1.5rem 1.25rem; border-radius: 10px; }
    h1 { font-size: 1.5rem; }
  }

  @media (prefers-color-scheme: dark) {
    body { background: #1a1815; color: #e8e4dc; }
    .card { background: #25221d; border-color: #3a362f; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); }
    h1 { color: #f0ece4; }
    .subtitle, .field-label, .field-hint, .step-label { color: #a8a29a; }
    input[type=text], input[type=password] {
      background: #1f1c18; border-color: #3a362f; color: #e8e4dc;
    }
    input[type=text]:focus, input[type=password]:focus {
      background: #25221d;
    }
    .brand-tag { border-color: #3a362f; color: #a8a29a; }
    .explainer { background: rgba(74, 124, 89, 0.12); border-color: #3a362f; }
    .preview-card { background: rgba(212, 160, 23, 0.15); }
    .done-tile { border-color: #3a362f; }
    .op-log { background: #1f1c18; border-color: #3a362f; }
  }
`;
