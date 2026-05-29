/**
 * Public-exposure security warning (#186). Once the operator brings up
 * cloudflare or Tailscale Funnel, `/login` is reachable from the public
 * internet on every layer admitting traffic. After #188's `/login` rate-limit
 * floor, the owner password is the wall.
 *
 * 2FA at the hub login layer is the planned next layer of defense — "password +
 * something-you-have" — but it isn't shipped yet (#473). So this warning no
 * longer recommends `parachute auth 2fa enroll` (that command writes vault YAML
 * that does NOT gate hub `/login`, and post auth-unification it just exits 1).
 * Instead it nudges toward a strong owner password and "don't expose /login if
 * a guessable password is a concern."
 *
 * Why this is a warning, not a hard gate: hard-gating would surprise operators
 * mid-flow — they ran `parachute expose public` to expose, not to be told
 * "set up 2FA first." A loud, contextual warning + a clear remediation is the
 * right shape; the operator decides whether to act now or later. The tunnel is
 * up regardless.
 *
 * The probe still consults `readVaultAuthStatus().hasTotp` (true only when a
 * legacy vault `config.yaml` carries a non-empty `totp_secret`) to suppress the
 * warning for operators who DID set up the legacy vault TOTP — even though it
 * doesn't gate hub login, suppressing avoids nagging them. Once hub-login TOTP
 * (#473) lands with a hub-side column, this reads that instead.
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
  log("⚠ /login is now reachable on the public internet");
  log(`  (${opts.publicUrl}/login). Anyone who guesses your password is in.`);
  log("");
  log("  2FA at the hub login layer is coming (#473) but isn't shipped yet —");
  log("  for now your owner password is the wall. Make sure it's a strong one:");
  log("");
  log("    parachute auth set-password");
  log("");
  log("  If a guessable password is a concern, don't expose /login publicly.");
  return true;
}
