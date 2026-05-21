/**
 * Bootstrap token for first-boot wizard claim (hub#297).
 *
 * On a fresh deploy with no admin row AND no `PARACHUTE_INITIAL_ADMIN_*`
 * env-seed, the hub enters "wizard mode" — the `/admin/setup` URL is
 * unauthenticated and the first POST to `/admin/setup/account` claims
 * the admin. On a public-reachable deploy (Render, Fly, a tailnet with
 * funnel on) the URL is reachable the moment the platform provisions
 * the hostname, so an attacker who beats the operator to the form can
 * claim the admin themselves. Same shape HashiCorp Vault hardens with
 * its `vault operator init` unseal-key dance.
 *
 * This module is the gate. On hub start in wizard mode:
 *
 *   1. `generateBootstrapToken()` produces a fresh `parachute-bootstrap-<rand>`
 *      string. It lives in this module's in-memory state — never persisted,
 *      regenerated on every process restart so a leaked stale value can't
 *      claim a hub that's already been restarted past its window.
 *   2. The caller logs it prominently on the startup banner so the
 *      operator (the only one with shell access to the box / Render logs)
 *      can copy it into the wizard form.
 *   3. The wizard's account form prompts for the token; the POST handler
 *      calls `verifyBootstrapToken(...)` (constant-time compare) before
 *      letting `createUser` run. Wrong token → 401; right token →
 *      `consumeBootstrapToken()` clears the in-memory value so a later
 *      racer can't reuse it.
 *
 * Env-seeded admins (`PARACHUTE_INITIAL_ADMIN_USERNAME` +
 * `PARACHUTE_INITIAL_ADMIN_PASSWORD`) bypass the token entirely — they've
 * claimed the hub by setting env vars on the platform, so the wizard's
 * account step is never reached. The token is generated only when
 * `seedInitialAdminIfNeeded` returns `"needs-setup"`.
 *
 * Threading: the wizard reads the token via a getter injected into
 * `SetupWizardDeps`, not via a direct module import. That keeps tests
 * able to drive a known token without touching process state, and keeps
 * the on-box CLI (`parachute expose`) able to skip token-gating entirely
 * (it never enters wizard mode — the on-box operator already has shell
 * access to call `parachute auth create-admin`).
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

const BOOTSTRAP_TOKEN_PREFIX = "parachute-bootstrap-";

/**
 * Module-scoped, mutable. Set by `generateBootstrapToken` / `setBootstrapToken`,
 * read by `getBootstrapToken`, cleared by `consumeBootstrapToken` (on
 * successful claim) or `clearBootstrapToken` (test cleanup). Never written
 * to disk. Re-generated on every hub start when the wizard-mode condition
 * holds; absent otherwise (env-seed path or admin-exists path skips
 * generation altogether).
 */
let currentToken: string | undefined;

/**
 * Generate a fresh bootstrap token and stash it. Returns the full
 * `parachute-bootstrap-<rand>` string. The random tail is 32 bytes
 * base64url-encoded (~43 chars), so the full token is ~63 chars —
 * comfortably unguessable, not so long the operator can't copy it.
 *
 * Idempotent within a single boot: calling twice replaces the prior
 * value. In practice the caller (`commands/serve.ts`) only calls once
 * during the wizard-mode branch of `seedInitialAdminIfNeeded`, so this
 * mostly matters for tests that re-init the module between cases.
 */
export function generateBootstrapToken(): string {
  // 32 bytes of randomness → 43 base64url chars (no padding). Plenty of
  // entropy (256 bits) against any attacker who can guess at line rate.
  const raw = randomBytes(32);
  const tail = raw.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  currentToken = `${BOOTSTRAP_TOKEN_PREFIX}${tail}`;
  return currentToken;
}

/**
 * Read the current bootstrap token. Returns `undefined` when:
 *   - no token has been generated this boot (env-seeded admin or
 *     admin-already-exists path); OR
 *   - the token has been consumed by a successful admin-claim POST.
 *
 * Callers can use the `undefined` signal to render the form without a
 * token field (the env-seed-no-vault flow under Issue 2 — admin already
 * exists, wizard is just for vault provisioning, no token needed).
 */
export function getBootstrapToken(): string | undefined {
  return currentToken;
}

/**
 * Constant-time compare an operator-supplied string against the current
 * bootstrap token. Returns `false` when no token is active OR when the
 * supplied value doesn't match. Inputs of different length short-circuit
 * to `false` without touching `timingSafeEqual` — `timingSafeEqual`
 * throws on length-mismatched buffers, but length itself is non-secret
 * (the token format is fixed) so we don't need a constant-time length
 * check.
 *
 * Empty / non-string input returns `false`. The caller's API is "did the
 * operator type the right token?"; missing-and-wrong are the same UX.
 */
export function verifyBootstrapToken(supplied: string | null | undefined): boolean {
  if (currentToken === undefined) return false;
  if (typeof supplied !== "string" || supplied.length === 0) return false;
  if (supplied.length !== currentToken.length) return false;
  const a = Buffer.from(supplied, "utf8");
  const b = Buffer.from(currentToken, "utf8");
  // Defense in depth: timingSafeEqual asserts same length and throws
  // otherwise. We've already length-checked above, so the throw can only
  // fire if `supplied` carries a multi-byte unicode scalar that encodes
  // to a different number of UTF-8 bytes than its `.length`. Safer to
  // wrap than to leak a stack trace into the operator's response.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Consume the bootstrap token after a successful admin-claim. Subsequent
 * `verifyBootstrapToken` calls return `false`; `getBootstrapToken`
 * returns `undefined`. Use this on the success branch of the account
 * POST so a racing attacker who saw the right token in the operator's
 * over-the-shoulder screencast can't replay it.
 */
export function consumeBootstrapToken(): void {
  currentToken = undefined;
}

/**
 * Test seam: clear the in-memory token without going through the
 * "claim" path. Production callers should never touch this — the
 * lifecycle is "generate on wizard-mode boot, consume on successful
 * admin claim." Tests that drive multiple wizard scenarios in one
 * process need a way to reset the module between cases.
 *
 * Same effect as `consumeBootstrapToken` today, but kept as a separate
 * surface so future changes (e.g. "log a warning on explicit consume,
 * not on test cleanup") don't muddle the two intents.
 */
export function _resetBootstrapTokenForTests(): void {
  currentToken = undefined;
}

/**
 * Test seam: directly set the in-memory token to a known value so
 * tests can construct a request with the expected token without going
 * through `generateBootstrapToken` (and the random tail it produces).
 * Production callers always use `generateBootstrapToken`.
 */
export function _setBootstrapTokenForTests(token: string): void {
  currentToken = token;
}

export { BOOTSTRAP_TOKEN_PREFIX };
