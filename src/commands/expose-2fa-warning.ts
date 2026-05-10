/**
 * Public-exposure 2FA-enrollment warning (#186). Lands as the next layer of
 * defense after #188's `/login` rate-limit floor: once the operator brings
 * up cloudflare or Tailscale Funnel, `/login` is reachable from the public
 * internet on every layer admitting traffic. 2FA is the difference between
 * "password is the only wall" and "password + something-you-have."
 *
 * Why this is a warning, not a hard gate: hard-gating would surprise operators
 * mid-flow — they ran `parachute expose public` to expose, not to be told
 * "set up 2FA first." A loud, contextual warning + a clear one-line
 * remediation is the right shape; the operator decides whether to act now or
 * later. The tunnel is up regardless.
 *
 * Why the source-of-truth is vault's `config.yaml`: 2FA enrollment lives in
 * `parachute-vault` (the hub forwards `parachute auth 2fa enroll` to vault —
 * see `commands/auth.ts` `VAULT_FORWARDED_SUBCOMMANDS`). The hub's `users`
 * table has no TOTP column today; it will gain one when hub-admin login
 * verifies TOTP against vault. Until then, "is 2FA enrolled?" maps cleanly
 * to "does vault's config.yaml carry a non-empty `totp_secret`?", which is
 * exactly what `readVaultAuthStatus().hasTotp` returns.
 *
 * If vault isn't installed at all (rare for the cloudflare path — it requires
 * a vault entry — but possible on the tailnet/funnel path): `hasTotp` comes
 * back `false` and the warning still fires. The remediation
 * `parachute auth 2fa enroll` then surfaces vault's "install vault first"
 * error, which is the right next step regardless.
 */

import { type VaultAuthStatus, readVaultAuthStatus } from "../vault/auth-status.ts";

export interface Public2FAWarningOpts {
  /** Pre-computed status to skip on-disk probe (tests). Production omits. */
  status?: VaultAuthStatus;
  /** Forwarded to {@link readVaultAuthStatus} when `status` is not supplied. */
  vaultHome?: string;
  /** Sink for the warning lines. Defaults to console.log. */
  log?: (line: string) => void;
  /** Public URL the operator just brought up — embedded in the warning. */
  publicUrl: string;
}

/**
 * `true` when `totp_secret` is present and non-empty in vault's config.yaml,
 * `false` otherwise (missing vault, missing config.yaml, empty value).
 *
 * Source-of-truth note: TOTP storage is the vault's, not the hub's. See the
 * module-level doc comment.
 */
export function is2FAEnrolled(
  opts: { vaultHome?: string; status?: VaultAuthStatus } = {},
): boolean {
  const status =
    opts.status ?? readVaultAuthStatus(opts.vaultHome ? { vaultHome: opts.vaultHome } : {});
  return status.hasTotp;
}

/**
 * Print a 2FA-enrollment warning to `log` when not enrolled. No-op when
 * enrolled. Returns `true` if the warning fired, `false` if suppressed —
 * primarily to make integration tests assert the branch without scraping log
 * text.
 */
export function printPublic2FAWarning(opts: Public2FAWarningOpts): boolean {
  const log = opts.log ?? ((line: string) => console.log(line));
  if (
    is2FAEnrolled({
      ...(opts.vaultHome ? { vaultHome: opts.vaultHome } : {}),
      ...(opts.status ? { status: opts.status } : {}),
    })
  ) {
    return false;
  }
  log("");
  log("⚠ 2FA is not enrolled. /login is now reachable on the public internet");
  log(`  (${opts.publicUrl}/login). Anyone who guesses your password`);
  log("  is in. Strongly recommended:");
  log("");
  log("    parachute auth 2fa enroll");
  log("");
  log("  Adds TOTP + backup codes. Takes 30 seconds.");
  return true;
}
