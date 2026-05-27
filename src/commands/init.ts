/**
 * `parachute init` — fresh-install front door.
 *
 * Aaron's framing (2026-05-27): "On render I just install it and then the
 * wizard walks me through all that including installing vault; I think
 * that should be similar here. One quick thing to set it up then I can
 * walk through in CLI (probably parachute init or something) or ideally
 * I can visit the page and go through the wizard."
 *
 * The job: get the user from a fresh install to the admin SPA setup
 * wizard with one command. The wizard already handles vault install +
 * scribe install + first-boot bootstrap (`/admin/setup`). `init`'s
 * responsibility is narrower:
 *
 *   1. The hub binary is already on PATH (you can't `parachute init`
 *      without it). So "is hub installed" is always yes here.
 *   2. Is the hub *running* on this box? If not, start it.
 *   3. Print the canonical admin URL — local loopback if we're not
 *      exposed, the tailnet / cloudflare FQDN if we are.
 *   4. Offer to open the URL in a browser (macOS: `open`, Linux:
 *      `xdg-open`). Skip in non-TTY shells.
 *   5. If a vault is already configured, just confirm "looks good" and
 *      point at the URL. The wizard surfaces install-state internally —
 *      no need to duplicate that logic here.
 *
 * Idempotent: every re-run is safe. If hub is up and a vault row exists,
 * we print the URL and exit 0 without touching anything.
 */

import { spawnSync } from "node:child_process";
import { CONFIG_DIR, SERVICES_MANIFEST_PATH } from "../config.ts";
import { type ExposeState, readExposeState } from "../expose-state.ts";
import {
  type EnsureHubOpts,
  HUB_DEFAULT_PORT,
  HUB_SVC,
  ensureHubRunning,
  readHubPort,
} from "../hub-control.ts";
import { type AliveFn, defaultAlive, processState } from "../process-state.ts";
import { readManifestLenient } from "../services-manifest.ts";

export interface InitOpts {
  configDir?: string;
  manifestPath?: string;
  log?: (line: string) => void;
  /** Test seam: `processState` liveness check. */
  alive?: AliveFn;
  /**
   * Test seam: `ensureHubRunning` shim. Production uses the real one;
   * tests pass a stub that records calls without spawning.
   */
  ensureHub?: (opts: EnsureHubOpts) => Promise<{ pid: number; port: number; started: boolean }>;
  /** Test seam: expose-state reader. */
  readExposeStateFn?: () => ExposeState | undefined;
  /** Test seam: TTY check (production reads `process.stdin.isTTY`). */
  isTty?: boolean;
  /** Test seam: prompt for "open in browser?". */
  prompt?: (question: string) => Promise<string>;
  /**
   * Test seam: browser-open shim. Receives `url`; production shells out
   * to `open` (darwin) / `xdg-open` (linux). Returns true on success.
   */
  openBrowser?: (url: string) => boolean;
  /** Test seam: `process.platform`. */
  platform?: NodeJS.Platform;
  /**
   * If true, don't even ask about opening the browser. Convenient flag for
   * CI / scripts that just want the URL printed and exit 0.
   */
  noBrowser?: boolean;
}

/**
 * Compute the canonical admin URL. Prefers the live expose state (so a
 * user with an exposed hub sees the public URL, not the loopback) and
 * falls back to localhost when nothing is exposed.
 *
 * Returns `undefined` only when the hub port can't be determined and no
 * exposure is active — caller treats that as "hub didn't start" and
 * surfaces an actionable error.
 */
export function resolveAdminUrl(
  exposeState: ExposeState | undefined,
  hubPort: number | undefined,
): string | undefined {
  if (exposeState && exposeState.canonicalFqdn) {
    return `https://${exposeState.canonicalFqdn}/admin/`;
  }
  if (hubPort !== undefined) {
    return `http://127.0.0.1:${hubPort}/admin/`;
  }
  return undefined;
}

/**
 * Default browser-opener. Tries `open` on macOS, `xdg-open` on Linux, and
 * returns false when neither is available (Windows / WSL fallthrough +
 * misc Unixes ship `xdg-open` so coverage is decent without bringing in
 * a dependency).
 */
function defaultOpenBrowser(url: string, platform: NodeJS.Platform): boolean {
  const cmd = platform === "darwin" ? "open" : platform === "linux" ? "xdg-open" : undefined;
  if (!cmd) return false;
  // spawnSync's `stdio: "ignore"` keeps the launcher quiet; we'll log the
  // outcome ourselves.
  const result = spawnSync(cmd, [url], { stdio: "ignore" });
  return result.status === 0;
}

async function defaultPrompt(question: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export async function init(opts: InitOpts = {}): Promise<number> {
  const configDir = opts.configDir ?? CONFIG_DIR;
  const manifestPath = opts.manifestPath ?? SERVICES_MANIFEST_PATH;
  const log = opts.log ?? ((line) => console.log(line));
  const alive = opts.alive ?? defaultAlive;
  const ensureHub = opts.ensureHub ?? ensureHubRunning;
  const readExposeStateFn = opts.readExposeStateFn ?? (() => readExposeState());
  const isTty = opts.isTty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const prompt = opts.prompt ?? defaultPrompt;
  const platform = opts.platform ?? process.platform;
  const openBrowser = opts.openBrowser ?? ((url: string) => defaultOpenBrowser(url, platform));

  log("Parachute init — getting your hub set up.");
  log("");

  // Step 1: hub running?
  const hubState = processState(HUB_SVC, configDir, alive);
  let hubPort: number | undefined;
  if (hubState.status === "running") {
    hubPort = readHubPort(configDir);
    log(`✓ Hub already running (pid ${hubState.pid}${hubPort ? `, port ${hubPort}` : ""}).`);
  } else {
    log("Hub not running — starting it now…");
    try {
      const result = await ensureHub({ configDir, log: () => {} });
      hubPort = result.port;
      log(`✓ Hub started (pid ${result.pid}, port ${result.port}).`);
    } catch (err) {
      log(`✗ Hub failed to start: ${err instanceof Error ? err.message : String(err)}`);
      log("");
      log("Try checking the logs:");
      log("  parachute logs hub");
      return 1;
    }
  }

  // Fall back to the default canonical port if `readHubPort` returned
  // undefined (which can happen if the hub was started by some prior tool
  // that didn't write a port file). The hub binds 1939 unless explicitly
  // overridden, so the fallback is almost always correct.
  if (hubPort === undefined) hubPort = HUB_DEFAULT_PORT;

  // Step 2: vault configured?
  let hasVault = false;
  try {
    const manifest = readManifestLenient(manifestPath);
    hasVault = manifest.services.some((s) => s.name.startsWith("parachute-vault"));
  } catch {
    // Lenient reader doesn't throw on most shapes, but be defensive — a
    // malformed services.json shouldn't crash init. The wizard handles it.
    hasVault = false;
  }

  // Step 3: resolve the admin URL.
  const exposeState = readExposeStateFn();
  const adminUrl = resolveAdminUrl(exposeState, hubPort);
  if (!adminUrl) {
    log("");
    log("✗ Couldn't resolve an admin URL (no hub port, no exposure state).");
    log("  This shouldn't happen if hub started successfully — file an issue.");
    return 1;
  }

  log("");
  if (hasVault) {
    log("Looks good — your hub is up and a vault is configured.");
  } else {
    log("Next: finish setup in the admin wizard (installs vault, configures admin user).");
  }
  log("");
  log(`  ${adminUrl}`);
  log("");

  // Step 4: offer to open the browser. Skip in non-TTY shells (CI),
  // honor `--no-browser`.
  if (opts.noBrowser) return 0;
  if (!isTty) {
    log("(Open the URL above in a browser to continue.)");
    return 0;
  }
  if (platform !== "darwin" && platform !== "linux") {
    log("(Open the URL above in your browser to continue.)");
    return 0;
  }
  const answer = (await prompt("Open in your browser now? [Y/n] ")).trim().toLowerCase();
  if (answer === "n" || answer === "no") return 0;
  const ok = openBrowser(adminUrl);
  if (!ok) {
    log("");
    log("(Couldn't launch a browser — open the URL above manually.)");
  }
  return 0;
}
