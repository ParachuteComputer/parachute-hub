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
 *     canonical onboarding (install hub → wizard → install Notes →
 *     authorize) shouldn't bounce the operator through a manual approve
 *     step they just set up the hub for.
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
  // hub#275: which dist-tag the runtime module installer uses
  // (`bun add -g <pkg>@<channel>`). `"latest"` (default) tracks the
  // stable channel; `"rc"` follows the release-candidate chain so
  // operators on the rc cadence can pull pre-release builds without
  // hand-editing the install command. Seeded from
  // `PARACHUTE_MODULE_CHANNEL` on first read (operator can ship a fresh
  // box with the env var set and have the row land with their preferred
  // channel); after the first seed the row is source of truth and the
  // env var is ignored — admin must use the SPA toggle (or
  // `PUT /api/modules/channel`) to change channel.
  | "module_install_channel";

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
 * Env var that seeds `module_install_channel` on first read. Read only
 * when the hub_settings row is absent — once the row exists, the env
 * var is ignored on subsequent boots (admin must use the SPA toggle or
 * the API to change channel). Lets Aaron's fresh-machine deploys ship
 * with `PARACHUTE_MODULE_CHANNEL=rc` baked into the platform's env
 * config without baking the channel into the binary or first-boot.
 */
export const PARACHUTE_MODULE_CHANNEL_ENV = "PARACHUTE_MODULE_CHANNEL";

/** Fallback when nothing else is set — the stable channel. */
export const DEFAULT_MODULE_INSTALL_CHANNEL: ModuleInstallChannel = "latest";

/**
 * Read the configured module install channel. On first call (no row in
 * hub_settings), seeds from `process.env.PARACHUTE_MODULE_CHANNEL` if
 * valid, otherwise defaults to `"latest"` (an invalid env value warns
 * + still falls back to "latest"). After that first seed, the
 * hub_settings row is source of truth.
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
  const existing = getSetting(db, "module_install_channel");
  if (existing !== undefined) {
    // Row already seeded — trust it. If somehow corrupted (manual sqlite
    // edit, schema drift), fall back to "latest" silently rather than
    // crashing the install path. Re-seeding the row is left to the
    // admin's explicit setModuleInstallChannel call.
    if (isModuleInstallChannel(existing)) return existing;
    return DEFAULT_MODULE_INSTALL_CHANNEL;
  }
  const env = opts.env ?? process.env;
  const warn = opts.warn ?? ((msg: string) => console.warn(msg));
  const fromEnv = env[PARACHUTE_MODULE_CHANNEL_ENV];
  let seed: ModuleInstallChannel = DEFAULT_MODULE_INSTALL_CHANNEL;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    if (isModuleInstallChannel(fromEnv)) {
      seed = fromEnv;
    } else {
      warn(
        `[hub-settings] ${PARACHUTE_MODULE_CHANNEL_ENV}="${fromEnv}" is not a valid channel — expected one of ${MODULE_INSTALL_CHANNELS.join(", ")}. Falling back to "${DEFAULT_MODULE_INSTALL_CHANNEL}".`,
      );
    }
  }
  setSetting(db, "module_install_channel", seed);
  return seed;
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
