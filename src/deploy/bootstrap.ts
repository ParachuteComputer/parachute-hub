/**
 * First-boot bootstrap for `parachute deploy` machines.
 *
 * Runs once when a freshly-provisioned cloud VM (Tier 1: Fly machine) starts.
 * Reads a minimal env contract written by the deploy command, installs the
 * configured Parachute modules onto the machine's persistent volume, and
 * drops a marker so subsequent boots no-op.
 *
 * Design: docs/design/2026-04-29-parachute-deploy.md (§4 step 2 — first-boot bake).
 *
 * Env contract (all optional except CLAUDE_API_TOKEN):
 *   - PARACHUTE_VAULT_NAME       — vault slug. Default: "default".
 *   - PARACHUTE_MODULES          — comma-separated shortnames. Default: "vault,scribe,notes" (Tier 1).
 *   - PARACHUTE_SCRIBE_PROVIDER  — pre-pick a scribe transcription provider so install
 *                                  doesn't prompt on a non-TTY container.
 *   - PARACHUTE_SCRIBE_KEY       — API key for the chosen scribe provider.
 *   - CLAUDE_API_TOKEN           — required. Threaded from the user's paste at deploy time;
 *                                  persisted to the config-dir .env so any module on the
 *                                  box can read it (e.g. an Anthropic-backed scribe
 *                                  provider, or paraclaw once Tier 2 lands).
 *
 * Idempotency: the marker at `<configDir>/bootstrap.json` short-circuits a
 * re-run on machine restart. A failed install does NOT write the marker, so
 * the next boot retries cleanly.
 *
 * Tier 2 modules (paraclaw) are rejected with a clear error — `parachute
 * deploy` v1 only stands up the personal-knowledge tier.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type InstallOpts, install } from "../commands/install.ts";
import { configDir as defaultConfigDir } from "../config.ts";
import { parseEnvFile, upsertEnvLine, writeEnvFile } from "../env-file.ts";

/** Tier 1 module set per the parachute-deploy design doc. Hub is implicit. */
export const DEFAULT_MODULES = ["vault", "scribe", "notes"] as const;

/** Default vault slug when PARACHUTE_VAULT_NAME isn't supplied. */
export const DEFAULT_VAULT_NAME = "default";

/**
 * Modules carved into Tier 2 by the parachute-deploy design. Passing one in
 * PARACHUTE_MODULES is rejected with a load-bearing error so users (and
 * misconfigured CI) don't silently try to install something v1 can't host.
 */
const TIER2_MODULES = new Set<string>(["paraclaw"]);

export interface BootstrapMarker {
  /** ISO 8601 timestamp of bootstrap completion. */
  bootstrapped_at: string;
  /** Modules that were installed on this machine (in install order). */
  modules: string[];
  /** Vault slug that was created. */
  vault_name: string;
  /** Hub package version that ran the bootstrap. */
  parachute_version: string;
}

export interface BootstrapOpts {
  /** Process env. Tests inject a synthetic env; production reads `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Override the resolved config dir. Tests point this at a tmpdir. */
  configDir?: string;
  /** Output sink. Tests capture into an array; production logs to stdout. */
  log?: (line: string) => void;
  /** Test seam replacing the per-module install() call. */
  installFn?: (input: string, installOpts: InstallOpts) => Promise<number>;
  /** Extra opts merged into every install() call (runner, manifest path, …). */
  baseInstallOpts?: Partial<InstallOpts>;
  /** Test seam: deterministic timestamp for the marker. */
  now?: () => Date;
  /** Override the version stamped into the marker. Tests pin it. */
  parachuteVersion?: string;
}

export interface BootstrapResult {
  exitCode: number;
  /** Present on success and on idempotent re-run; absent on failure. */
  marker?: BootstrapMarker;
  /** True when the marker already existed and bootstrap was a no-op. */
  alreadyBootstrapped?: boolean;
}

export async function bootstrap(opts: BootstrapOpts = {}): Promise<BootstrapResult> {
  const env = opts.env ?? process.env;
  const dir = opts.configDir ?? defaultConfigDir(env);
  const log = opts.log ?? ((line: string) => console.log(line));
  const installFn = opts.installFn ?? install;
  const now = opts.now ?? (() => new Date());
  const version = opts.parachuteVersion ?? readPackageVersion();
  const markerPath = join(dir, "bootstrap.json");

  if (existsSync(markerPath)) {
    log(`bootstrap: marker already at ${markerPath} — already provisioned, no-op.`);
    const existing = readMarker(markerPath);
    return existing
      ? { exitCode: 0, marker: existing, alreadyBootstrapped: true }
      : { exitCode: 0, alreadyBootstrapped: true };
  }

  const claudeToken = (env.CLAUDE_API_TOKEN ?? "").trim();
  if (claudeToken.length === 0) {
    log("bootstrap: ✗ CLAUDE_API_TOKEN is required.");
    log("  The `parachute deploy` command threads it from the user's paste-at-deploy step;");
    log("  missing it means the machine was started outside that flow.");
    return { exitCode: 1 };
  }

  // Container-bootstrap ephemeral-layer guard: PARACHUTE_HOME must point at
  // the persistent volume mount (e.g. /data on a Fly machine). When it isn't
  // set, configDir() falls back to ~/.parachute under the running user's
  // homedir, which on a Fly machine is a writable layer of the *image* —
  // looks fine until the next deploy/restart wipes it. Warn loudly so a
  // misconfigured machine config gets caught before the user notices their
  // vault evaporated.
  //
  // We check `defaultConfigDir(env)` rather than the resolved `dir` so an
  // injected `opts.configDir` (tests, future integration harnesses) doesn't
  // false-positive when the override happens to live under homedir; the
  // question is "what would the production resolver return for this env?",
  // not "where is this particular invocation writing".
  if ((env.PARACHUTE_HOME ?? "").length === 0 && defaultConfigDir(env).startsWith(homedir())) {
    log(`bootstrap: ⚠ PARACHUTE_HOME is not set — config dir resolved to ${dir} (under homedir).`);
    log(
      "  On a containerized deploy this is the ephemeral image layer; data will NOT survive restart.",
    );
    log("  Set PARACHUTE_HOME to your volume mount path (e.g. /data) in the machine env.");
  }

  const vaultName = pickVaultName(env);
  const modules = parseModuleList(env);

  const tier2 = modules.filter((m) => TIER2_MODULES.has(m));
  if (tier2.length > 0) {
    log(
      `bootstrap: ✗ module(s) ${tier2.join(", ")} are Tier 2 and not part of \`parachute deploy\` v1.`,
    );
    log(
      "  See docs/design/2026-04-29-parachute-deploy.md — Tier 1 is hub + vault + scribe + notes.",
    );
    return { exitCode: 1 };
  }

  log(
    `bootstrap: starting (modules: ${modules.join(", ")}, vault: ${vaultName}, configDir: ${dir})`,
  );

  // Persist CLAUDE_API_TOKEN into the config-dir .env. This makes the secret
  // available to every module process on the box without forcing each one to
  // know about a deploy-specific env var. ANTHROPIC_API_KEY is the name the
  // Anthropic SDK + scribe's anthropic provider both look for; setting both
  // covers the common cases and costs us nothing.
  mkdirSync(dir, { recursive: true });
  persistTokenIntoEnvFile(join(dir, ".env"), claudeToken);

  // install() is itself idempotent (see install.ts:418-441 — the bun-add gate
  // skips re-linking when the package is already wired). That's what lets a
  // failed mid-loop bootstrap retry cleanly on the next boot without
  // double-installing the modules that already succeeded.
  for (const short of modules) {
    log(`bootstrap: — ${short} —`);
    const installOpts: InstallOpts = {
      log,
      configDir: dir,
      ...opts.baseInstallOpts,
    };
    if (short === "vault") {
      installOpts.vaultName = vaultName;
    }
    if (short === "scribe") {
      const provider = (env.PARACHUTE_SCRIBE_PROVIDER ?? "").trim();
      const key = (env.PARACHUTE_SCRIBE_KEY ?? "").trim();
      if (provider.length > 0) installOpts.scribeProvider = provider;
      if (key.length > 0) installOpts.scribeKey = key;
    }
    const code = await installFn(short, installOpts);
    if (code !== 0) {
      log(
        `bootstrap: ✗ install ${short} exited ${code} — aborting, marker NOT written so the next boot retries.`,
      );
      return { exitCode: code };
    }
  }

  const marker: BootstrapMarker = {
    bootstrapped_at: now().toISOString(),
    modules: [...modules],
    vault_name: vaultName,
    parachute_version: version,
  };
  writeMarkerAtomic(markerPath, marker);
  log(`bootstrap: ✓ complete — marker written to ${markerPath}`);
  return { exitCode: 0, marker };
}

/**
 * Atomic marker write — tmp + rename, mirroring `writeEnvFile` in env-file.ts.
 * Guards against the readMarker() check at next boot picking up a half-written
 * file if the process is killed mid-write (Fly host maintenance, OOM kill, etc).
 */
function writeMarkerAtomic(path: string, marker: BootstrapMarker): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(marker, null, 2)}\n`);
  renameSync(tmp, path);
}

function pickVaultName(env: NodeJS.ProcessEnv): string {
  const raw = (env.PARACHUTE_VAULT_NAME ?? "").trim();
  return raw.length > 0 ? raw : DEFAULT_VAULT_NAME;
}

function parseModuleList(env: NodeJS.ProcessEnv): string[] {
  const raw = (env.PARACHUTE_MODULES ?? "").trim();
  if (raw.length === 0) return [...DEFAULT_MODULES];
  const parts = raw
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
  return parts.length > 0 ? parts : [...DEFAULT_MODULES];
}

function readMarker(path: string): BootstrapMarker | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as BootstrapMarker;
  } catch {
    return null;
  }
}

function persistTokenIntoEnvFile(path: string, token: string): void {
  const parsed = parseEnvFile(path);
  let lines = parsed.lines;
  lines = upsertEnvLine(lines, "CLAUDE_API_TOKEN", token);
  lines = upsertEnvLine(lines, "ANTHROPIC_API_KEY", token);
  writeEnvFile(path, lines);
}

function readPackageVersion(): string {
  try {
    const url = new URL("../../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(url, "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

if (import.meta.main) {
  const result = await bootstrap();
  process.exit(result.exitCode);
}
