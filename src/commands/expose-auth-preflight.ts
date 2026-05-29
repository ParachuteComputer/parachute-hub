/**
 * Post-exposure auth nudge. Runs after `parachute expose public` successfully
 * brings a tunnel up (TTY only). The tunnel is already live; this is purely
 * advisory — we never error the exposure flow regardless of what the user
 * chooses. The goal is to catch the "fresh vault, just went public, no auth
 * configured" trap before someone else finds it first.
 *
 * The load-bearing signal is the **owner password**. Post-pvt_*-DROP (vault
 * #412 / hub#466), the vault `tokens` table holds only vestigial pvt_* rows;
 * a non-zero count no longer means "API auth is configured." Access is now
 * hub-issued JWTs, minted against the operator's identity — and minting that
 * identity requires the owner password (browser OAuth) or the operator token
 * that `set-password` seeds. So "has an owner password" is the single gate
 * that tells us whether *any* authenticated access is reachable. We branch
 * purely on password + 2FA; we no longer count vault-DB rows for the auth
 * decision.
 *
 * Two states we branch on, based on {@link VaultAuthStatus}:
 *
 *   - no owner password: loud warning — the exposure is wide open. Offer to
 *     set a password, and point at the hub-JWT mint path for clients.
 *   - password set: one-line "looks good" + an honest note that hub-login 2FA
 *     isn't shipped yet (#473), so the owner password is the wall.
 *
 * We no longer offer "enable 2FA": `parachute auth 2fa enroll` forwarded to the
 * deprecated vault stub, which post auth-unification exits 1 and (on the old
 * happy path) only wrote vault YAML that never gated hub `/login`. Offering it
 * was a dead path. Real hub-login TOTP is tracked at #473.
 *
 * Defaults are always "skip" — Enter declines every prompt. User can always
 * run `parachute auth set-password` / `parachute auth mint-token …` later.
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

/**
 * Honest note that hub-login 2FA isn't shipped yet. Replaces the old
 * `offerTotp` (which ran the dead `parachute auth 2fa enroll` path). No prompt —
 * there's nothing actionable to offer until #473 lands.
 */
function note2faComing(r: Resolved): void {
  r.log("");
  r.log("Note: 2FA at the hub login layer is coming (#473) but isn't shipped yet —");
  r.log("for now the owner password is the wall, so keep it strong.");
}

/**
 * Programmatic / headless clients don't use a password — they carry a
 * hub-issued JWT. We don't auto-mint one here (it needs a scope, and the
 * operator should choose read vs write per client), so this is guidance,
 * not a prompt. Mint paths, in order of how most operators reach them:
 *
 *   - Admin SPA → Vaults → "Connect" card (mints + shows the header command).
 *   - `parachute auth mint-token --scope vault:<name>:<verb>` (pipeable JWT).
 *
 * The old affordance ran `parachute vault tokens create`, which exits 1
 * post-DROP (vault no longer mints pvt_* tokens) — we never offer it.
 */
function printTokenGuidance(r: Resolved): void {
  const name = r.status.vaultNames[0] ?? "<name>";
  r.log("");
  r.log("For programmatic / headless clients (scripts, CI), mint a hub token:");
  r.log("  • Admin → Vaults → Connect  (mints a scope-narrow token + copy-paste header)");
  r.log(`  • parachute auth mint-token --scope vault:${name}:read   # or :write`);
  r.log("    → attach the printed JWT as  Authorization: Bearer <hub-jwt>");
}

function printDivider(r: Resolved): void {
  r.log("");
  r.log("──────────────────────────────────────────────────────────────");
}

/**
 * `no owner password`: the exposure is wide open — without a password,
 * nobody can sign in and no hub JWT can be minted, so there's no auth gate
 * at all. The loudest warning we draw.
 */
async function handleWideOpen(r: Resolved): Promise<void> {
  printDivider(r);
  r.log("⚠  No owner password is configured.");
  r.log("   The tunnel is reachable from the public internet RIGHT NOW.");
  r.log("   Anyone with the URL can make requests until you set auth up.");
  r.log("");
  r.log("Recommended: set an owner password — it's the gate for both browser");
  r.log("sign-in (OAuth) and minting hub tokens for programmatic clients.");
  r.log("");
  await offerOwnerPassword(r);
  // Programmatic-client guidance is informational (no auto-mint) — print it
  // so the operator knows the headless path exists, not the dead pvt_* one.
  printTokenGuidance(r);
  // Honest 2FA state — coming (#473), not yet shippable.
  note2faComing(r);
  printDivider(r);
}

/**
 * `password set`: the operator did the obvious thing. One-line confirmation
 * plus the honest 2FA note. (We don't assert on tokens — a hub JWT is minted
 * on demand, not a standing prerequisite.)
 */
function handlePasswordSet(r: Resolved): void {
  r.log("");
  r.log("✓  Owner password is set.");
  note2faComing(r);
}

/**
 * Pick the branch. Pure function of the status — keeps test coverage trivial.
 *
 * Owner-password-centric since the pvt_* DROP (hub#466): `tokenCount` is no
 * longer consulted — those rows are vestigial and minting access now flows
 * through the owner password, not a standing vault token. 2FA isn't a branch
 * anymore (hub-login TOTP not shipped — #473): two states.
 */
function classify(s: VaultAuthStatus): "wide-open" | "password-set" {
  if (!s.hasOwnerPassword) return "wide-open";
  return "password-set";
}

export async function runAuthPreflight(opts: AuthPreflightOpts = {}): Promise<void> {
  const r = resolve(opts);
  switch (classify(r.status)) {
    case "wide-open":
      await handleWideOpen(r);
      return;
    case "password-set":
      handlePasswordSet(r);
      return;
  }
}
