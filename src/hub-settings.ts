/**
 * Hub-local key/value settings (hub#268).
 *
 * Bare KV table backing two wizard-adjacent features:
 *
 *   * `setup_expose_mode` — `localhost | tailnet | public`. The operator's
 *     "how will this hub be reached?" choice from the first-boot wizard's
 *     expose step. The done step reads it to surface the right reachable-at
 *     URL + next-step instructions.
 *
 *   * `pending_first_client_auto_approve_until` — ISO-8601 timestamp. Set
 *     when the wizard finishes (60 minutes in the future); the next OAuth
 *     client to hit `/oauth/register` *within* that window is auto-approved
 *     (single-use, the value is cleared on consume). Past-due or absent
 *     means the standard pending-approval flow applies. Motivator: a
 *     canonical onboarding (install hub → expose → wizard installs
 *     vault/surface → authorize) shouldn't bounce the operator through a
 *     manual approve step they just set up the hub for.
 *
 * Schema lives in `hub-db.ts` migration v7. This module is just the typed
 * accessor — single-row reads/writes per key, no joins, no caching. The
 * call frequency is low (a handful of reads on `/oauth/register` + the
 * wizard's done step) so the obvious shape wins.
 */
import type { Database } from "bun:sqlite";

// Adding a setting: extend this union + write a typed accessor. The table itself is generic KV.
export type HubSettingKey =
  | "setup_expose_mode"
  | "pending_first_client_auto_approve_until"
  // hub#272: auto-minted operator token surfaced once on the wizard's
  // done screen. Single-use — the done-step renderer reads + deletes the
  // row so a subsequent GET (page refresh, back button) doesn't re-show
  // the secret. Lives in hub_settings rather than tokens because it's a
  // wizard-flow ephemeral, not a persistent issued credential — the
  // mintOperatorToken call still records the jti in the `tokens`
  // registry, so revocation works as usual.
  | "setup_minted_token"
  // hub#267: the typed vault name. Persisted at vault POST time so the
  // done step can render the operator's choice in the MCP URL +
  // install-command snippet without re-deriving from services.json
  // (vault's first-boot may write its own paths shape that the wizard
  // can't trust to match `<name>` exactly until the spawn settles).
  | "setup_vault_name"
  // hub#168 Cut 2: operator explicitly chose Skip on the vault step.
  // The vault module is installed (init.ts ran `install vault
  // --no-create` per Cut 1), but no first-vault instance was created
  // or imported. `deriveWizardState` consults this flag to advance
  // past the vault step on subsequent GETs even though `hasVault`
  // remains false. Value is the literal string "true" when set; absent
  // means "operator hasn't skipped". Cleared if the operator later
  // creates a vault from the admin SPA — that path can either delete
  // this row directly or let the next wizard GET notice `hasVault ===
  // true` and ignore the skip flag.
  | "setup_vault_skipped"
  // hub#275: which dist-tag the runtime module installer uses
  // (`bun add -g <pkg>@<channel>`). `"latest"` (default) tracks the
  // stable channel; `"rc"` follows the release-candidate chain so
  // operators on the rc cadence can pull pre-release builds without
  // hand-editing the install command.
  //
  // Precedence (hub#381, 2026-05-25 — flipped from "DB after first
  // seed"): env > DB > default. Env vars recognized:
  // `PARACHUTE_INSTALL_CHANNEL` (canonical), `PARACHUTE_MODULE_CHANNEL`
  // (legacy alias). When env is set it wins on every read; the SPA
  // toggle still writes to this row as the fallback for when env is
  // later unset.
  | "module_install_channel"
  // hub#298: operator-settable canonical hub URL. The value (when set)
  // is the OAuth issuer claim stamped into every JWT minted by hub.
  // Precedence on each request: this row, then `PARACHUTE_HUB_ORIGIN`
  // env, then `new URL(req.url).origin` as the local-dev fallback.
  //
  // Storing the canonical origin in hub_settings (rather than relying
  // solely on the env var) lets a Render operator attach a custom
  // domain after first boot + flip the issuer URL from the admin SPA
  // without restarting the container. Tokens minted before the change
  // carry the old `iss` claim; tokens minted after carry the new one.
  // Operators must accept that flipping the canonical hub URL
  // invalidates any tokens already in circulation (issuer mismatch on
  // verification) — surfaced in the admin SPA's helper copy.
  | "hub_origin"
  // Notes-as-app migration Phase 2 (parachute-app design doc §16).
  // When unset (default) or "false", hub serves a 301 redirect from
  // `/notes/*` → `/surface/notes/*` so existing bookmarks transparently
  // follow the operator to the apps-hosted Notes. When "true", the
  // redirect is skipped and `/notes/*` falls through to the existing
  // services.json-driven proxy — the escape hatch for operators
  // running notes-as-a-module only (no parachute-app installed yet)
  // who want the legacy daemon to keep serving its old mount during
  // the deprecation window. Stored as the literal string "true" /
  // "false"; any other value parses as "redirect on" (the migration
  // default — operators must opt out, not opt in).
  | "notes_redirect_disabled";

export type SetupExposeMode = "localhost" | "tailnet" | "public";

/**
 * Set of valid `setup_expose_mode` values. Exported so the POST handler
 * + the wizard renderer can both reference the same truth.
 */
export const SETUP_EXPOSE_MODES: readonly SetupExposeMode[] = ["localhost", "tailnet", "public"];

export function isSetupExposeMode(s: unknown): s is SetupExposeMode {
  return typeof s === "string" && SETUP_EXPOSE_MODES.includes(s as SetupExposeMode);
}

interface Row {
  value: string;
}

/**
 * Read a setting's value, or undefined when absent. No type coercion —
 * the caller knows what shape it expects.
 */
export function getSetting(db: Database, key: HubSettingKey): string | undefined {
  const row = db.query<Row, [string]>("SELECT value FROM hub_settings WHERE key = ?").get(key);
  return row?.value;
}

/**
 * Write (or overwrite) a setting. UPSERT semantics — the SQLite
 * `ON CONFLICT(key) DO UPDATE` shape is the canonical way and works back
 * to the hub's SQLite minimum. `updated_at` is bumped on every write,
 * even idempotent re-writes of the same value, so an operational poll
 * could distinguish stale vs fresh state.
 */
export function setSetting(
  db: Database,
  key: HubSettingKey,
  value: string,
  now: () => Date = () => new Date(),
): void {
  const ts = now().toISOString();
  db.prepare(
    `INSERT INTO hub_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, ts);
}

/**
 * Remove a setting. Idempotent — deleting an already-absent key is a
 * no-op (the `auto_approve_until` consume-and-clear path relies on this
 * shape so the OAuth register handler doesn't have to check existence
 * twice).
 */
export function deleteSetting(db: Database, key: HubSettingKey): void {
  db.prepare("DELETE FROM hub_settings WHERE key = ?").run(key);
}

// --- domain helpers: auto-approve window ---------------------------------

/**
 * Default window during which the first OAuth client registration is
 * auto-approved after the wizard completes. The brief specifies 60
 * minutes; exported as a constant so tests can clamp the clock without
 * threading the magic number through every callsite.
 */
export const FIRST_CLIENT_AUTO_APPROVE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Open the auto-approve window. Called from the wizard's vault POST
 * success path (the "wizard is now done" transition). Idempotent — if a
 * prior window already exists, it's overwritten with a fresh expiry.
 * That's fine: re-firing the wizard's done transition for any reason
 * resets the window, which is the predictable behavior.
 */
export function openFirstClientAutoApproveWindow(
  db: Database,
  now: () => Date = () => new Date(),
): void {
  const expires = new Date(now().getTime() + FIRST_CLIENT_AUTO_APPROVE_WINDOW_MS);
  setSetting(db, "pending_first_client_auto_approve_until", expires.toISOString(), now);
}

/**
 * Check whether a first-client auto-approve window is currently open
 * (set and in the future). Pure read; no consumption. Used by the
 * OAuth register handler to decide whether to mint `approved` vs
 * `pending`.
 */
export function isFirstClientAutoApproveWindowOpen(
  db: Database,
  now: () => Date = () => new Date(),
): boolean {
  const raw = getSetting(db, "pending_first_client_auto_approve_until");
  if (!raw) return false;
  const expiresAt = Date.parse(raw);
  if (Number.isNaN(expiresAt)) return false;
  return expiresAt > now().getTime();
}

/**
 * Consume the auto-approve window. Returns true if a window was open
 * and was successfully consumed; false otherwise (already expired,
 * never opened, or already consumed). The window is single-use — clear
 * the setting on consume so the next client falls through to the
 * standard pending-approval flow.
 *
 * This is the canonical entry point on the OAuth register path. The
 * shape is "check + consume" in one call to keep the OAuth handler
 * narrow + race-free under a single-writer assumption (hub is a single
 * SQLite writer).
 */
export function consumeFirstClientAutoApproveWindow(
  db: Database,
  now: () => Date = () => new Date(),
): boolean {
  if (!isFirstClientAutoApproveWindowOpen(db, now)) return false;
  deleteSetting(db, "pending_first_client_auto_approve_until");
  return true;
}

// --- domain helpers: module install channel ------------------------------

/**
 * Which dist-tag `bun add -g <pkg>@<channel>` should use. `"latest"`
 * tracks the stable channel; `"rc"` tracks pre-release builds. Exposed
 * here (not buried in api-modules-ops) because the admin SPA reads it
 * via `/api/modules` and writes it via `/api/modules/channel` — the
 * setting is the cross-cutting source of truth, the install path is
 * one consumer.
 */
export type ModuleInstallChannel = "latest" | "rc";

/** Exported so the API handler + the SPA toggle can share validation. */
export const MODULE_INSTALL_CHANNELS: readonly ModuleInstallChannel[] = ["latest", "rc"];

export function isModuleInstallChannel(s: unknown): s is ModuleInstallChannel {
  return typeof s === "string" && MODULE_INSTALL_CHANNELS.includes(s as ModuleInstallChannel);
}

/**
 * Env vars consulted by `getModuleInstallChannel`. Both names are
 * recognized; `PARACHUTE_INSTALL_CHANNEL` (the operator-facing name
 * documented in `parachute --help` and used by `src/commands/install.ts`
 * + `src/api-modules-ops.ts`) is preferred. `PARACHUTE_MODULE_CHANNEL`
 * is the legacy name kept for back-compat with deploys that already
 * baked it into their env config; it's a back-compat alias and may
 * be retired one rc-chain after this lands.
 *
 * **Precedence (changed 2026-05-25 — was DB-first):** env > DB > default.
 * An operator who sets the env var in their platform dashboard expects
 * that value to be authoritative on every boot — the prior "DB always
 * wins after first seed" behavior produced the failure mode Aaron hit
 * (set env=rc, container restarted, UI still showed `latest` because
 * DB had been seeded with the default at first boot before the env was
 * set). Bug #137 in the audit.
 *
 * When the env is set, the SPA's channel toggle is shadowed (writes go
 * through to the DB but the env-set value still wins on read). That
 * trade-off is acceptable for container deploys where env is the
 * canonical source; operators who want SPA-driven control should unset
 * the env var.
 */
export const PARACHUTE_INSTALL_CHANNEL_ENV = "PARACHUTE_INSTALL_CHANNEL";
export const PARACHUTE_MODULE_CHANNEL_ENV = "PARACHUTE_MODULE_CHANNEL"; // legacy alias

/** Fallback when nothing else is set — the stable channel. */
export const DEFAULT_MODULE_INSTALL_CHANNEL: ModuleInstallChannel = "latest";

/**
 * Resolve the env-set channel, if any. Returns the channel value or
 * `null` when no env var is set or only invalid values are present.
 * Invalid values call `warn()` and are skipped (caller falls through
 * to DB/default). Never throws.
 */
function resolveChannelFromEnv(
  env: NodeJS.ProcessEnv,
  warn: (msg: string) => void,
): ModuleInstallChannel | null {
  for (const name of [PARACHUTE_INSTALL_CHANNEL_ENV, PARACHUTE_MODULE_CHANNEL_ENV]) {
    const raw = env[name];
    if (typeof raw !== "string" || raw.length === 0) continue;
    if (isModuleInstallChannel(raw)) return raw;
    warn(
      `[hub-settings] ${name}="${raw}" is not a valid channel — expected one of ${MODULE_INSTALL_CHANNELS.join(", ")}. Falling back to "${DEFAULT_MODULE_INSTALL_CHANNEL}".`,
    );
  }
  return null;
}

/**
 * Read the configured module install channel.
 *
 * Precedence: env (PARACHUTE_INSTALL_CHANNEL > PARACHUTE_MODULE_CHANNEL)
 * > DB (hub_settings) > default ("latest").
 *
 * The DB is still seeded with the resolved value on first read so the
 * SPA shows a stable "current channel" even when env is set — but the
 * env always wins on read, so a platform-level env change takes effect
 * immediately without operator intervention.
 *
 * The `env` + `warn` knobs are test seams — production uses
 * `process.env` + `console.warn`. Tests inject a deterministic shape so
 * the warn-on-invalid branch can be asserted without console-capture.
 */
export function getModuleInstallChannel(
  db: Database,
  opts: {
    env?: NodeJS.ProcessEnv;
    warn?: (msg: string) => void;
  } = {},
): ModuleInstallChannel {
  const env = opts.env ?? process.env;
  const warn = opts.warn ?? ((msg: string) => console.warn(msg));

  // Env wins.
  const fromEnv = resolveChannelFromEnv(env, warn);
  if (fromEnv !== null) {
    // Do NOT write to DB — that would overwrite a separate operator-driven
    // value (e.g. an SPA toggle while env was unset). The DB tracks the
    // last operator-written value as a fallback for when env is later
    // unset; env just shadows on read. Cost: the SPA's "current channel"
    // indicator may show the DB value while env is shadowing it. Future
    // work (#137 follow-up) can expose a `source` field so the SPA can
    // surface "shadowed by env" UX.
    return fromEnv;
  }

  // Env unset → DB next.
  const existing = getSetting(db, "module_install_channel");
  if (existing !== undefined) {
    if (isModuleInstallChannel(existing)) return existing;
    // Corrupted value (manual sqlite edit, schema drift) — fall through
    // to default silently rather than crashing the install path.
    return DEFAULT_MODULE_INSTALL_CHANNEL;
  }

  // Neither env nor DB → seed default + return.
  setSetting(db, "module_install_channel", DEFAULT_MODULE_INSTALL_CHANNEL);
  return DEFAULT_MODULE_INSTALL_CHANNEL;
}

/**
 * Write the module install channel. Validated by the caller (the API
 * handler + the SPA already constrain to the union); the function
 * itself only accepts the typed shape, so a TypeScript-clean callsite
 * can't write a malformed value.
 */
export function setModuleInstallChannel(db: Database, channel: ModuleInstallChannel): void {
  setSetting(db, "module_install_channel", channel);
}

// --- domain helpers: canonical hub origin --------------------------------

/**
 * Read the operator-set canonical hub origin from hub_settings. Returns
 * `null` when no row is present — callers fall through to env / request-
 * origin precedence in that case (see `resolveIssuer` in hub-server).
 *
 * Unlike `module_install_channel` this helper does NOT seed from env on
 * first read. The env var (`PARACHUTE_HUB_ORIGIN`) remains a separate
 * precedence layer below this one — operators who set the env var still
 * see "from env" attribution in the admin SPA. Auto-seeding would
 * collapse that layer into the row + lose the source attribution.
 */
export function getHubOrigin(db: Database): string | null {
  const value = getSetting(db, "hub_origin");
  return value ?? null;
}

/**
 * Write or clear the canonical hub origin. Passing `null` deletes the
 * row, reverting to env / request-origin precedence on subsequent
 * requests. The caller must have validated the URL shape — the
 * function trusts the input and writes verbatim (mirrors
 * `setModuleInstallChannel`'s "typed-callsite is the contract" stance).
 *
 * Empty-string is treated as null (the value would never be a useful
 * issuer) to avoid storing a row that no codepath would honor — the
 * resolveIssuer fallback chain would skip it as falsy and the source
 * label would lie about where the value came from.
 */
export function setHubOrigin(db: Database, value: string | null): void {
  if (value === null || value === "") {
    deleteSetting(db, "hub_origin");
    return;
  }
  setSetting(db, "hub_origin", value);
}

// --- domain helpers: notes-as-app redirect (parachute-app §16 Phase 2) ----

/**
 * Read whether the `/notes/*` → `/surface/notes/*` redirect is disabled. Default
 * is `false` (redirect on) — Phase 2 migrates operators to apps-hosted
 * Notes, so the bookmark-friendly path is the default-on behavior. Only an
 * operator running notes-as-a-module without parachute-app installed should
 * flip this to `true`.
 *
 * Returns `true` only when the stored value is the literal string "true".
 * Any other value (missing row, "false", typo, empty string) means
 * redirect-enabled — the migration-default direction.
 */
export function isNotesRedirectDisabled(db: Database): boolean {
  return getSetting(db, "notes_redirect_disabled") === "true";
}

/**
 * Write the notes-redirect opt-out flag. The string form ("true"/"false")
 * mirrors how other boolean-ish settings would land if we add them — the
 * KV table is TEXT-typed, and centralizing the encoding here keeps any
 * future caller from accidentally storing "1" / "0" / "on" / etc.
 *
 * Passing `false` deletes the row rather than writing the string "false"
 * — the absent-row state is the canonical "redirect on" default, and
 * leaving an explicit "false" in the row would be a footgun if a future
 * default flip ever made absence mean something different. (Mirrors the
 * `setHubOrigin(null)` semantics.)
 */
export function setNotesRedirectDisabled(db: Database, value: boolean): void {
  if (value) {
    setSetting(db, "notes_redirect_disabled", "true");
  } else {
    deleteSetting(db, "notes_redirect_disabled");
  }
}
