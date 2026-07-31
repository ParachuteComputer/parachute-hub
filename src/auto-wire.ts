import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { restart as lifecycleRestart } from "./commands/lifecycle.ts";
import { parseEnvFile, removeEnvLine, upsertEnvLine, writeEnvFile } from "./env-file.ts";
import { type AliveFn, defaultAlive, processState } from "./process-state.ts";
import { PORT_RESERVATIONS } from "./service-spec.ts";

/**
 * Cross-service auto-wiring for shared secrets.
 *
 * Vault's transcription worker authenticates to scribe over loopback using a
 * shared bearer token, and reaches scribe at SCRIBE_URL. On install, when both
 * services are present, we mint the secret and pin the URL on vault's side so
 * the operator never has to. Missing either service → no-op; values already
 * present in vault's .env → preserved.
 *
 * Storage locations (convention, matches what each service reads at boot):
 *   ~/.parachute/vault/.env        SCRIBE_AUTH_TOKEN=<value>
 *                                  SCRIBE_URL=http://127.0.0.1:1943
 *   ~/.parachute/scribe/config.json  { "auth": { "required_token": "<value>" } }
 *
 * Idempotency rule: we don't regenerate the token if vault's .env already
 * carries it, and we don't overwrite SCRIBE_URL if already set. This preserves
 * operator-set overrides and keeps repeat installs from churning state in a
 * way that would break an already-running vault worker.
 *
 * After writing, if vault is running, restart it so the worker re-reads the
 * .env. Without the restart vault keeps the old (or empty) values in process
 * env and voice memos sit with `_Transcript pending._` forever — exactly the
 * launch-day footgun this auto-wire exists to prevent.
 */

export const SCRIBE_AUTH_ENV_KEY = "SCRIBE_AUTH_TOKEN";
export const SCRIBE_URL_ENV_KEY = "SCRIBE_URL";

export interface AutoWireOpts {
  configDir: string;
  /** Override for tests; must return a hex string of any reasonable length. */
  randomToken?: () => string;
  log?: (line: string) => void;
  /** Test seam: liveness check used to decide whether to restart vault. */
  alive?: AliveFn;
  /**
   * Test seam: restart hook for vault. Defaults to `lifecycle.restart("vault")`.
   * Tests inject a fake to assert the call without spawning a real child.
   */
  restartService?: (short: string) => Promise<number>;
}

export interface AutoWireResult {
  /** True when a token was written this call (vs. preserved from a prior wire). */
  generated: boolean;
  /** The token value, whether newly minted or pre-existing. */
  token: string;
  /** The SCRIBE_URL value present in vault .env after this call. */
  scribeUrl: string;
  vaultEnvPath: string;
  scribeConfigPath: string;
  /** True when vault was running and we issued a restart. */
  restartedVault: boolean;
}

function defaultRandomToken(): string {
  return randomBytes(32).toString("hex");
}

function defaultScribeUrl(): string {
  // Pull scribe's canonical port from the single source of truth so a future
  // port change doesn't drift between auto-wire and the rest of the CLI.
  const port = PORT_RESERVATIONS.find((p) => p.name === "parachute-scribe")?.port ?? 1943;
  return `http://127.0.0.1:${port}`;
}

function writeScribeConfig(path: string, token: string): void {
  mkdirSync(dirname(path), { recursive: true });
  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        current = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed config — overwrite. Auto-wire owns this file's auth block;
      // repairing a user-broken JSON is not our job.
    }
  }
  const existingAuth =
    typeof current.auth === "object" && current.auth !== null && !Array.isArray(current.auth)
      ? (current.auth as Record<string, unknown>)
      : {};
  const next = {
    ...current,
    auth: { ...existingAuth, required_token: token },
  };
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * Read scribe's current `auth.required_token` from `config.json`, or undefined
 * when the file is absent / malformed / has no auth token. Used by the
 * serve-boot self-heal to decide whether scribe's config is already in sync
 * with vault's `.env`.
 */
function readScribeAuthToken(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const auth = (parsed as Record<string, unknown>).auth;
    if (!auth || typeof auth !== "object" || Array.isArray(auth)) return undefined;
    const token = (auth as Record<string, unknown>).required_token;
    return typeof token === "string" && token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Mint (or preserve) a shared secret and persist it to vault and scribe, plus
 * pin SCRIBE_URL on vault's side. Caller has already confirmed both services
 * are installed. Restarts vault if it's running so the worker re-reads .env.
 */
/** What {@link unwireScribeAuth} actually changed. */
export interface UnwireResult {
  /** Keys removed from vault's .env (empty when there was nothing to remove). */
  readonly removed: string[];
  /** Whether the .env file was rewritten. */
  readonly changed: boolean;
}

/**
 * The counterpart to {@link autoWireScribeAuth}: drop the auto-wired scribe
 * keys from vault's `.env` when scribe is uninstalled.
 *
 * ## Why this has to exist
 *
 * Install wires `SCRIBE_URL` + `SCRIBE_AUTH_TOKEN` into vault's env *for* the
 * operator. Uninstall didn't unwire them, so removing scribe left vault
 * pointing its transcription worker at a port with nothing behind it —
 * `[transcribe] worker started → http://127.0.0.1:1943` on a box where 1943 is
 * dead. Nothing errors at boot; audio just stops being transcribed.
 *
 * It also defeats vault's own recovery. Vault#640 made `whisper-cpp` the
 * default provider unless a scribe is configured — and a stale `SCRIBE_URL`
 * reads as "configured", so the box that most needs the local default is
 * exactly the one that doesn't get it. Machine-written config has to be
 * machine-removed; leaving it is asymmetry that reads as an operator's
 * deliberate choice.
 *
 * Removes ONLY the two keys install writes, never the whole file, and is a
 * no-op when they're absent (uninstall must stay idempotent).
 */
export function unwireScribeAuth(opts: {
  configDir: string;
  log?: (line: string) => void;
}): UnwireResult {
  const log = opts.log ?? (() => {});
  const vaultEnvPath = join(opts.configDir, "vault", ".env");

  // Vault may not be installed at all — nothing to unwire, not an error.
  if (!existsSync(vaultEnvPath)) return { removed: [], changed: false };

  const parsed = parseEnvFile(vaultEnvPath);
  let lines = parsed.lines;
  const removed: string[] = [];

  for (const key of [SCRIBE_URL_ENV_KEY, SCRIBE_AUTH_ENV_KEY]) {
    const existing = parsed.values[key];
    if (existing !== undefined) {
      lines = removeEnvLine(lines, key);
      removed.push(key);
    }
  }

  if (removed.length === 0) return { removed: [], changed: false };

  writeEnvFile(vaultEnvPath, lines);
  log(
    `removed ${removed.join(" + ")} from vault .env — vault falls back to its ` +
      `default transcription provider (run \`parachute-vault transcription install\` ` +
      `to set up local transcription).`,
  );
  return { removed, changed: true };
}

// `autoWireScribeAuth` lived here until scribe's retirement (hub#809). It minted
// a shared secret at INSTALL time and wrote it to both sides. With every install
// path now refusing scribe, it had no callers left.
//
// Deliberately NOT deleted alongside it:
//   - `selfHealScribeAuth` runs on every `parachute serve` boot and keeps an
//     EXISTING supervised scribe's auth aligned with vault's .env. That's the
//     constituency graceful retirement exists to protect — a box transcribing
//     today must keep transcribing, with auth intact rather than drifting open.
//   - `unwireScribeAuth` runs on uninstall, and is what stops a removed scribe
//     leaving vault pointed at a dead :1943 (which would also suppress vault's
//     whisper-cpp fallback).
//
// What's gone is the token-MINTING write path for a module we no longer install.

export interface SelfHealScribeAuthResult {
  /** True when scribe's config.json was written this call (was missing/out-of-sync). */
  healed: boolean;
  /**
   * Why no heal happened (when `healed` is false): "no-token" (vault .env has
   * no SCRIBE_AUTH_TOKEN — nothing to sync) or "already-synced" (scribe already
   * carries the same token). Undefined when `healed` is true.
   */
  reason?: "no-token" | "already-synced";
}

/**
 * Idempotent self-heal of scribe's `auth.required_token`, run on hub `serve`
 * startup (item H — the loopback-open finding).
 *
 * The gap: `autoWireScribeAuth` only fires from `parachute install scribe` (and
 * the vault↔scribe install pairing). An install that PREDATES auto-wire — or
 * any path where scribe booted with no `auth.required_token` — leaves scribe
 * accepting UNAUTHENTICATED transcription requests over loopback forever; the
 * shared secret never lands in scribe's config even though vault's `.env`
 * already carries `SCRIBE_AUTH_TOKEN`. Install-time wiring can't fix an
 * already-installed box.
 *
 * The fix mirrors the issuer self-heal in `vault-hub-origin-env.ts`: run on
 * every `serve` boot, fully idempotent. When vault's `.env` carries a
 * `SCRIBE_AUTH_TOKEN` AND scribe's `config.json` either lacks
 * `auth.required_token` or carries a DIFFERENT value, write/sync the vault
 * value into scribe's config (via `writeScribeConfig`'s merge-don't-clobber
 * logic — only the auth token is touched, every other config key is preserved).
 * Vault's `.env` is treated as the source of truth (it's where the operator's
 * worker reads the secret from). No-op when vault has no token (nothing to
 * sync) or the two already match. Does NOT restart scribe — `serve` boots the
 * supervised modules AFTER this runs, so the synced config is read on that
 * first boot; an already-running scribe (manual start) is the operator's to
 * restart, same posture as the issuer self-heal.
 *
 * Logs only when it actually heals.
 */
export function selfHealScribeAuth(opts: {
  configDir: string;
  log?: (line: string) => void;
}): SelfHealScribeAuthResult {
  const log = opts.log ?? (() => {});
  const vaultEnvPath = join(opts.configDir, "vault", ".env");
  const scribeConfigPath = join(opts.configDir, "scribe", "config.json");

  const vaultToken = parseEnvFile(vaultEnvPath).values[SCRIBE_AUTH_ENV_KEY];
  if (vaultToken === undefined || vaultToken.length === 0) {
    // Nothing to sync — vault hasn't been wired with a scribe secret. (Either
    // scribe isn't in use, or auto-wire never ran on either side.)
    return { healed: false, reason: "no-token" };
  }

  const scribeToken = readScribeAuthToken(scribeConfigPath);
  if (scribeToken === vaultToken) {
    return { healed: false, reason: "already-synced" };
  }

  writeScribeConfig(scribeConfigPath, vaultToken);
  log(
    scribeToken === undefined
      ? `Self-healed scribe auth: wrote required_token to ${scribeConfigPath} (scribe was running auth-OPEN; synced from vault ${SCRIBE_AUTH_ENV_KEY}).`
      : `Self-healed scribe auth: re-synced required_token in ${scribeConfigPath} to match vault ${SCRIBE_AUTH_ENV_KEY}.`,
  );
  return { healed: true };
}
