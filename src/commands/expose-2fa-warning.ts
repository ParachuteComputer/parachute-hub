/**
 * Public-exposure security warning (#186). Once the operator brings up
 * cloudflare or Tailscale Funnel, `/login` is reachable from the public
 * internet on every layer admitting traffic. After #188's `/login` rate-limit
 * floor, the owner password is the wall — and now (hub#473) hub-login TOTP 2FA
 * is the second wall.
 *
 * 2FA at the hub login layer is real as of hub#473: "password +
 * something-you-have." This warning recommends `parachute auth 2fa enroll`
 * (which now gates hub `/login` for real) when the operator hasn't enrolled.
 *
 * Why this is a warning, not a hard gate: hard-gating would surprise operators
 * mid-flow — they ran `parachute expose public` to expose, not to be told
 * "set up 2FA first." A loud, contextual warning + a clear remediation is the
 * right shape; the operator decides whether to act now or later. The tunnel is
 * up regardless.
 *
 * The probe consults `readVaultAuthStatus().hasTotp`, which now reflects the
 * hub.db `users.totp_secret` column (real hub-login 2FA) — true when any user
 * has enrolled. The warning fires only when no second factor is configured.
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
 * `true` when a second factor is configured, `false` otherwise. As of hub#473
 * this reflects the hub.db `users.totp_secret` column (real hub-login 2FA),
 * with the legacy vault `config.yaml` `totp_secret` as a fallback for old
 * installs — see {@link readVaultAuthStatus} and the module-level doc comment.
 */
export function is2FAEnrolled(
  opts: { vaultHome?: string; hubDbPath?: string; status?: VaultAuthStatus } = {},
): boolean {
  const status =
    opts.status ??
    readVaultAuthStatus({
      ...(opts.vaultHome ? { vaultHome: opts.vaultHome } : {}),
      ...(opts.hubDbPath ? { hubDbPath: opts.hubDbPath } : {}),
    });
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
  log("  Turn on two-factor authentication — it adds a second wall (a one-time");
  log("  code from your authenticator app) on top of your password:");
  log("");
  log("    parachute auth 2fa enroll");
  log("");
  log("  (Or set it up in the browser at /account/2fa for a scannable QR code.)");
  log("  Either way, also make sure your owner password is a strong one:");
  log("");
  log("    parachute auth set-password");
  return true;
}
