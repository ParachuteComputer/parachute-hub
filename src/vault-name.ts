/**
 * Vault-name validation, mirrored from `@openparachute/vault`'s
 * `src/vault-name.ts`.
 *
 * The vault package owns the canonical validator (used by `init`, the
 * `--vault-name` flag, and the `PARACHUTE_VAULT_NAME` env var on
 * first-boot). Hub doesn't depend on vault at runtime, so we keep a
 * byte-identical contract here and pin parity with a test that exercises
 * the same rule set:
 *
 *   * lowercase alphanumeric + hyphens or underscores
 *   * 2–32 chars
 *   * `list` / `new` / `assets` / `admin` are reserved (see
 *     `RESERVED_VAULT_NAMES` below — one consolidated set for every hub
 *     edge, per the 2026-06-09 hub-module-boundary migration B2)
 *
 * If vault's validator changes (e.g. additional reserved name, length
 * relaxation), the two must move in lockstep — hub passing the typed
 * name through `PARACHUTE_VAULT_NAME` only works as long as vault accepts
 * what hub validates. Cross-repo drift here would silently fall back to
 * `default` at vault first-boot (vault's `resolveFirstBootVaultName`
 * downgrades env-invalid values).
 *
 * Out of scope: collision against existing vaults on the same hub — the
 * wizard only ever creates the first vault, so name reuse can't happen.
 * Subsequent vaults go through the admin SPA, which talks to vault's own
 * `/vault/list` endpoint.
 */

/**
 * Canonical vault-name charset: lowercase alphanumerics + hyphen/underscore.
 * Exported as the single source of truth for the hub edge sites that mint /
 * create vaults (item I) — `admin-vaults.ts`, `account-vault-token.ts`,
 * `admin-vault-admin-token.ts` historically accepted `[a-zA-Z0-9_-]`, a
 * superset of what vault's init enforces. The case drift was a real bug class:
 * a hub-side `Work` would never match vault's URL-derived `work`, so the minted
 * token's audience (`vault.Work`) wouldn't validate, and a created vault name
 * could diverge from what vault persisted. Pinning every hub edge to THIS
 * lowercase-only regex closes the drift.
 */
export const VAULT_NAME_CHARSET_RE = /^[a-z0-9_-]+$/;
const VAULT_NAME_RE = VAULT_NAME_CHARSET_RE;
const VAULT_NAME_MIN_LEN = 2;
const VAULT_NAME_MAX_LEN = 32;

/**
 * THE reserved vault-name set — single source of truth for every hub edge
 * that names a vault (B2h of the 2026-06-09 hub-module-boundary migration).
 * Before the consolidation hub carried TWO drifted sets: this file held only
 * `list` (gating the setup wizard + invite redemption via `validateVaultName`)
 * while `admin-vaults.ts` held `{list, new, assets}` (gating POST /vaults
 * only) — so a non-admin invite redeemer could squat names an admin couldn't.
 *
 *   - `list`   — mirrors vault's own `cmdCreate` reservation (legacy
 *     `/vaults/list` discovery endpoint; cross-repo consistency is cheap).
 *   - `new`    — collides with `/vault/new`, the SPA's create-vault route.
 *   - `assets` — collides with `/vault/assets/*`, the SPA's static bundle.
 *   - `admin`  — collides with `/vault/admin`, the daemon-level mount for
 *     vault's own multi-vault admin surface (B-route). A vault named `admin`
 *     would capture the mount.
 *
 * DELETE /vaults/<name> deliberately does NOT consult this set — a squatted
 * reserved-name vault (created before the reservation) must be removable.
 */
export const RESERVED_VAULT_NAMES: ReadonlySet<string> = new Set([
  "list",
  "new",
  "assets",
  "admin",
]);

export type VaultNameValidation = { ok: true; name: string } | { ok: false; error: string };

/**
 * Validate a vault name against vault's strict contract. Trims
 * surrounding whitespace before checking. Returns the trimmed name on
 * success so callers don't double-trim.
 */
export function validateVaultName(raw: string): VaultNameValidation {
  const name = raw.trim();
  if (!name) {
    return { ok: false, error: "vault name cannot be empty." };
  }
  if (name.length < VAULT_NAME_MIN_LEN || name.length > VAULT_NAME_MAX_LEN) {
    return {
      ok: false,
      error: `vault names must be ${VAULT_NAME_MIN_LEN}–${VAULT_NAME_MAX_LEN} characters long.`,
    };
  }
  if (!VAULT_NAME_RE.test(name)) {
    return {
      ok: false,
      error: "vault names must be lowercase alphanumeric with hyphens or underscores.",
    };
  }
  if (RESERVED_VAULT_NAMES.has(name)) {
    return { ok: false, error: `"${name}" is a reserved vault name.` };
  }
  return { ok: true, name };
}

/** The default vault name when the operator leaves the field blank. */
export const DEFAULT_VAULT_NAME = "default";
