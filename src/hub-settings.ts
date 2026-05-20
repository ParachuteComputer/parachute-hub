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
  | "setup_vault_name";

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
