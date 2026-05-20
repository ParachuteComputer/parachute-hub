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
 *   * `list` is reserved
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

const VAULT_NAME_RE = /^[a-z0-9_-]+$/;
const VAULT_NAME_MIN_LEN = 2;
const VAULT_NAME_MAX_LEN = 32;

const RESERVED_NAMES = new Set([
  // Mirrors vault's reservation. Collides with the legacy `/vaults/list`
  // discovery endpoint; the routes have moved under `/vault/<name>/` but
  // vault's `cmdCreate` still rejects "list" and cross-repo consistency
  // is cheap.
  "list",
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
  if (RESERVED_NAMES.has(name)) {
    return { ok: false, error: `"${name}" is a reserved vault name.` };
  }
  return { ok: true, name };
}

/** The default vault name when the operator leaves the field blank. */
export const DEFAULT_VAULT_NAME = "default";
