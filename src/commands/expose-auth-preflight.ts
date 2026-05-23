/**
 * Post-exposure auth nudge. Runs after `parachute expose public` successfully
 * brings a tunnel up (TTY only). The tunnel is already live; this is purely
 * advisory — we never error the exposure flow regardless of what the user
 * chooses. The goal is to catch the "fresh vault, just went public, no
 * password or tokens set" trap before someone else finds it first.
 *
 * Four states we branch on, based on {@link VaultAuthStatus}:
 *
 *   - neither password nor tokens: loud warning + offer to set up each.
 *   - password, no 2FA: shorter "recommend 2FA" nudge.
 *   - tokens but no password: OAuth isn't set up; offer to add a password.
 *   - `tokenCount === null`: couldn't read the DB; advisory only, no prompts
 *     that depend on token state.
 *   - all set: one-line "looks good" (the quiet path).
 *
 * Defaults are always "skip" — Enter declines every prompt. User can always
 * run `parachute auth …` or `parachute vault tokens create` later.
 */

import { createInterface } from "node:readline/promises";
import { type VaultAuthStatus, readVaultAuthStatus } from "../vault/auth-status.ts";

/** `Bun.spawn(..., { stdio: "inherit" })` wrapper. Factored out so tests can
 *  assert which commands got invoked without running them. */
export type InteractiveRunner = (cmd: readonly string[]) => Promise<number>;

const defaultInteractiveRunner: InteractiveRunner = async (cmd) => {
  // Inherit env so subprocesses see PATH (to find `tailscale`), HOME, etc.
  // Bun.spawn defaults to empty env — see api-modules-ops.ts:defaultRun.
  const proc = Bun.spawn([...cmd], {
    stdio: ["inherit", "inherit", "inherit"],
    env: process.env,
  });
  return await proc.exited;
};

async function defaultPrompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export interface AuthPreflightOpts {
  /** Supply a pre-computed status to skip the on-disk read (tests). In
   *  production, leave unset and we'll call {@link readVaultAuthStatus}. */
  status?: VaultAuthStatus;
  prompt?: (question: string) => Promise<string>;
  interactiveRunner?: InteractiveRunner;
  log?: (line: string) => void;
  /** Forwarded to {@link readVaultAuthStatus} when `status` is not supplied. */
  vaultHome?: string;
}

interface Resolved {
  status: VaultAuthStatus;
  prompt: (question: string) => Promise<string>;
  interactiveRunner: InteractiveRunner;
  log: (line: string) => void;
}

function resolve(opts: AuthPreflightOpts): Resolved {
  return {
    status: opts.status ?? readVaultAuthStatus({ vaultHome: opts.vaultHome }),
    prompt: opts.prompt ?? defaultPrompt,
    interactiveRunner: opts.interactiveRunner ?? defaultInteractiveRunner,
    log: opts.log ?? ((line) => console.log(line)),
  };
}

/**
 * Prompt the user yes/no with Enter defaulting to "no" (skip). Returns true
 * only on an affirmative answer. Anything else — blank, "n", garbage — is a
 * decline; we don't reprompt, because the preflight is explicitly optional
 * and the user has already done the hard part.
 */
async function yesNo(r: Resolved, question: string): Promise<boolean> {
  const raw = (await r.prompt(`${question} [y/N] `)).trim().toLowerCase();
  return raw === "y" || raw === "yes";
}

async function runCmd(r: Resolved, cmd: readonly string[], friendly: string): Promise<void> {
  r.log("");
  const code = await r.interactiveRunner(cmd);
  if (code !== 0) {
    // Don't blow up the preflight on a sub-command failure — the user can
    // see the error, and the tunnel is still up. Just log a hint and move on.
    r.log(
      `(${friendly} exited ${code} — you can re-run \`${cmd.join(" ")}\` anytime. Continuing.)`,
    );
  }
}

async function offerOwnerPassword(r: Resolved): Promise<void> {
  if (await yesNo(r, "Set the owner password now?")) {
    await runCmd(r, ["parachute", "auth", "set-password"], "parachute auth set-password");
  }
}

async function offerTotp(r: Resolved): Promise<void> {
  if (await yesNo(r, "Enable TOTP 2FA now?")) {
    await runCmd(r, ["parachute", "auth", "2fa", "enroll"], "parachute auth 2fa enroll");
  }
}

async function offerTokenCreate(r: Resolved): Promise<void> {
  if (await yesNo(r, "Create an API token now?")) {
    await runCmd(r, ["parachute", "vault", "tokens", "create"], "parachute vault tokens create");
  }
}

function printDivider(r: Resolved): void {
  r.log("");
  r.log("──────────────────────────────────────────────────────────────");
}

/**
 * `neither password nor tokens`: the exposure is wide open — anyone who
 * finds the URL can talk to the vault. The loudest warning we draw.
 */
async function handleWideOpen(r: Resolved): Promise<void> {
  printDivider(r);
  r.log("⚠  No owner password and no API tokens are configured.");
  r.log("   The tunnel is reachable from the public internet RIGHT NOW.");
  r.log("   Anyone with the URL can make requests until you set auth up.");
  r.log("");
  r.log("Recommended: set an owner password (enables the browser sign-in flow)");
  r.log("and/or create an API token (for programmatic clients).");
  r.log("");
  await offerOwnerPassword(r);
  // Offer 2FA regardless of the password step outcome: we can't observe it
  // from outside the subprocess, and vault itself will reject a 2fa enroll
  // if there's no password yet, surfacing the real error to the user.
  await offerTotp(r);
  await offerTokenCreate(r);
  printDivider(r);
}

/**
 * `password set, no 2FA`: the common case where the user did the obvious
 * thing but hasn't opted into the stronger factor yet. Short nudge.
 */
async function handlePasswordNoTotp(r: Resolved): Promise<void> {
  r.log("");
  r.log("✓  Owner password is set.");
  r.log("   Consider also enabling 2FA for defense-in-depth.");
  await offerTotp(r);
}

/**
 * `tokens exist, no password`: vault is authenticated for API clients but
 * nobody can sign in through a browser — the hub's OAuth flow is dead in
 * the water. Offer to fix.
 */
async function handleTokensNoPassword(r: Resolved): Promise<void> {
  r.log("");
  r.log("ℹ  API tokens exist, but no owner password is set.");
  r.log("   Browser sign-in (OAuth) won't work until you add one.");
  await offerOwnerPassword(r);
}

/**
 * `tokenCount === null`: SQLite probe failed (DB missing, locked, schema
 * drift, whatever). Don't guess; don't prompt on token state. Nudge 2FA
 * if we know the password is set, otherwise stay quiet.
 */
async function handleUnknownTokens(r: Resolved): Promise<void> {
  r.log("");
  r.log("ℹ  Couldn't read vault token state (vault may be locked or offline).");
  r.log("   Run `parachute vault tokens list` to check token config yourself.");
  if (r.status.hasOwnerPassword && !r.status.hasTotp) {
    r.log("");
    r.log("   (While you're here: owner password is set, 2FA is not.)");
    await offerTotp(r);
  }
}

/**
 * `all set`: password + 2FA + at least one token. Keep it tight.
 */
function handleAllGood(r: Resolved): void {
  r.log("");
  r.log("✓  Auth config looks good (password + 2FA + API tokens).");
}

/**
 * Pick the branch. Pure function of the status — keeps test coverage trivial.
 */
function classify(
  s: VaultAuthStatus,
): "wide-open" | "password-no-totp" | "tokens-no-password" | "unknown-tokens" | "all-good" {
  if (s.tokenCount === null) return "unknown-tokens";
  const hasTokens = s.tokenCount > 0;
  if (!s.hasOwnerPassword && !hasTokens) return "wide-open";
  if (!s.hasOwnerPassword && hasTokens) return "tokens-no-password";
  if (s.hasOwnerPassword && !s.hasTotp) return "password-no-totp";
  return "all-good";
}

export async function runAuthPreflight(opts: AuthPreflightOpts = {}): Promise<void> {
  const r = resolve(opts);
  switch (classify(r.status)) {
    case "wide-open":
      await handleWideOpen(r);
      return;
    case "password-no-totp":
      await handlePasswordNoTotp(r);
      return;
    case "tokens-no-password":
      await handleTokensNoPassword(r);
      return;
    case "unknown-tokens":
      await handleUnknownTokens(r);
      return;
    case "all-good":
      handleAllGood(r);
      return;
  }
}
