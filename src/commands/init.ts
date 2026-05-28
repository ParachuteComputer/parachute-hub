/**
 * `parachute init` — fresh-install front door, single entry point for both
 * laptops and remote servers (EC2, DigitalOcean, Hetzner, any VPS).
 *
 * Aaron's framing (2026-05-28): "orient local install more to leveraging the
 * wizard if possible. Local install in this case should be extremely similar
 * to ec2, except that perhaps we get parachute expose set up first."
 *
 * The job: get the user from a fresh install to the admin SPA setup
 * wizard with one command, regardless of where the box lives. The wizard
 * already handles vault install + scribe install + first-boot bootstrap
 * (`/admin/setup`). `init`'s responsibility is narrower:
 *
 *   1. The hub binary is already on PATH (you can't `parachute init`
 *      without it). So "is hub installed" is always yes here.
 *   2. Is the hub *running* on this box? If not, start it.
 *   3. Is the hub already exposed (`expose-state.json` present)? If so,
 *      skip straight to printing the FQDN. Otherwise, in a TTY, ask
 *      whether the operator wants to expose it now — defaulting to
 *      "no, loopback" on a laptop and pre-selecting Cloudflare on a
 *      server (SSH session detected). Same command both paths.
 *   4. After any exposure chain, re-resolve and print the canonical
 *      admin URL — local loopback if we're not exposed, the tailnet /
 *      cloudflare FQDN if we are.
 *   5. Offer to open the URL in a browser (macOS: `open`, Linux:
 *      `xdg-open`). Skip in non-TTY shells.
 *   6. If a vault is already configured, confirm "looks good" and
 *      point at the URL. The wizard surfaces install-state internally —
 *      no need to duplicate that logic here.
 *
 * Idempotent: every re-run is safe. If hub is up and exposed (or the user
 * picked "no expose" once), the chain short-circuits.
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

/** The three options the exposure prompt offers — also the `--expose` flag's domain. */
export type ExposeChoice = "none" | "tailnet" | "cloudflare";

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
  /** Test seam: prompt for "open in browser?" and exposure choice. */
  prompt?: (question: string) => Promise<string>;
  /**
   * Test seam: browser-open shim. Receives `url`; production shells out
   * to `open` (darwin) / `xdg-open` (linux). Returns true on success.
   */
  openBrowser?: (url: string) => boolean;
  /** Test seam: `process.platform`. */
  platform?: NodeJS.Platform;
  /** Test seam: process.env for SSH / DISPLAY detection. */
  env?: NodeJS.ProcessEnv;
  /**
   * If true, don't even ask about opening the browser. Convenient flag for
   * CI / scripts that just want the URL printed and exit 0.
   */
  noBrowser?: boolean;
  /**
   * Non-interactive exposure choice. Skips the prompt entirely:
   *   - "none"       — no-op (laptop default)
   *   - "tailnet"    — chain into `exposeTailnet("up", {})`
   *   - "cloudflare" — chain into the cloudflare interactive flow
   * For CI / scripted deploys.
   */
  exposeChoice?: ExposeChoice;
  /** Skip the exposure prompt; fall through to "here's localhost URL". */
  noExposePrompt?: boolean;
  /**
   * Test seam: shim for the tailnet exposure chain. Production imports
   * `exposeTailnet` lazily. Tests pass a stub to record the call without
   * shelling out to `tailscale serve`.
   */
  exposeTailnetImpl?: () => Promise<number>;
  /**
   * Test seam: shim for the cloudflare exposure chain. Production imports
   * `exposePublicInteractive` with `preselect: "cloudflare"`. Tests pass a
   * stub to record the call without shelling out to `cloudflared`.
   */
  exposeCloudflareImpl?: () => Promise<number>;
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
  if (exposeState?.canonicalFqdn) {
    return `https://${exposeState.canonicalFqdn}/admin/`;
  }
  if (hubPort !== undefined) {
    return `http://127.0.0.1:${hubPort}/admin/`;
  }
  return undefined;
}

/**
 * Heuristic: is this likely a server (vs. a laptop)?
 *
 * Servers default-highlight Cloudflare in the prompt; laptops default to
 * "no expose". We don't auto-pick — always prompt — but pre-select the
 * sensible default so an operator can confirm with Enter.
 *
 * Signals:
 *   - Linux platform AND ($SSH_CONNECTION set OR no $DISPLAY)
 *
 * macOS / Windows / Linux desktop → laptop.
 */
export function looksLikeServer(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  if (platform !== "linux") return false;
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return true;
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return true;
  return false;
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

/**
 * Default chain into Tailscale exposure. Lazy-imports so tests don't pull
 * tailscale wiring into the init module's surface.
 */
async function defaultExposeTailnet(): Promise<number> {
  const { exposeTailnet } = await import("./expose.ts");
  return await exposeTailnet("up", {});
}

/**
 * Default chain into Cloudflare exposure. Goes through the interactive
 * flow with `preselect: "cloudflare"` so the operator gets walked
 * through install / login / hostname-prompt as needed.
 */
async function defaultExposeCloudflare(): Promise<number> {
  const { exposePublicInteractive } = await import("./expose-interactive.ts");
  return await exposePublicInteractive({ preselect: "cloudflare" });
}

/**
 * Prompt for the exposure choice. Returns the picked option, or
 * `undefined` if the operator quit / bailed.
 *
 * Default is whichever option matches the platform heuristic — laptops
 * default to "none", servers to "cloudflare". Empty input picks the
 * default (so Enter == confirm).
 */
async function promptExposeChoice(
  prompt: (q: string) => Promise<string>,
  log: (line: string) => void,
  defaultChoice: ExposeChoice,
): Promise<ExposeChoice | undefined> {
  log("Do you want to expose it publicly so you can reach it from other devices?");
  const mark = (c: ExposeChoice) => (c === defaultChoice ? " (default)" : "");
  log(`  1) No — keep it loopback-only (good for laptops)${mark("none")}`);
  log(`  2) Yes via Tailscale Funnel (private to your devices)${mark("tailnet")}`);
  log(`  3) Yes via Cloudflare Tunnel (public HTTPS, your own domain)${mark("cloudflare")}`);
  log("");

  const defaultDigit = defaultChoice === "none" ? "1" : defaultChoice === "tailnet" ? "2" : "3";

  // Bounded retries — a stuck prompt (non-TTY stdin that slipped through,
  // piped /dev/null, etc.) shouldn't spin forever.
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = (await prompt(`Pick [${defaultDigit}]: `)).trim().toLowerCase();
    if (raw === "") {
      return defaultChoice;
    }
    if (raw === "1" || raw === "no" || raw === "none") return "none";
    if (raw === "2" || raw === "tailnet" || raw === "tailscale") return "tailnet";
    if (raw === "3" || raw === "cloudflare") return "cloudflare";
    if (raw === "q" || raw === "quit" || raw === "exit") return undefined;
    log(`Sorry — expected 1, 2, 3, or q (got "${raw}"). Try again.`);
  }
  log("Too many invalid entries; falling back to default.");
  return defaultChoice;
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
  const env = opts.env ?? process.env;
  const openBrowser = opts.openBrowser ?? ((url: string) => defaultOpenBrowser(url, platform));
  const exposeTailnetImpl = opts.exposeTailnetImpl ?? defaultExposeTailnet;
  const exposeCloudflareImpl = opts.exposeCloudflareImpl ?? defaultExposeCloudflare;

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

  // Step 2: exposure chain. Skipped when already exposed, in non-TTY,
  // or when --no-expose-prompt was passed. `--expose <choice>` jumps
  // straight to the corresponding chain without asking.
  let exposeState = readExposeStateFn();
  const alreadyExposed = Boolean(exposeState?.canonicalFqdn);

  if (alreadyExposed) {
    // Already-exposed short-circuit: don't prompt. The admin URL printed
    // later will be the FQDN.
    log(`✓ Hub is already exposed at ${exposeState?.canonicalFqdn}.`);
  } else if (opts.exposeChoice !== undefined) {
    // Non-interactive override.
    const code = await runExposureChoice(opts.exposeChoice, {
      log,
      exposeTailnetImpl,
      exposeCloudflareImpl,
    });
    if (code !== 0) return code;
    // Refresh state — the chain may have brought up an FQDN.
    exposeState = readExposeStateFn();
  } else if (opts.noExposePrompt) {
    // Skip the question; fall through to localhost URL.
  } else if (!isTty) {
    // Non-TTY: don't prompt. Operator can re-run with --expose if needed.
  } else {
    log(`Hub is running locally at http://127.0.0.1:${hubPort}.`);
    log("");
    const isServer = looksLikeServer(platform, env);
    const defaultChoice: ExposeChoice = isServer ? "cloudflare" : "none";
    const picked = await promptExposeChoice(prompt, log, defaultChoice);
    if (picked === undefined) {
      log("");
      log("Skipped exposure. Re-run `parachute expose public` later if you want to.");
    } else if (picked !== "none") {
      log("");
      const code = await runExposureChoice(picked, {
        log,
        exposeTailnetImpl,
        exposeCloudflareImpl,
      });
      if (code !== 0) return code;
      exposeState = readExposeStateFn();
    }
  }

  // Step 3: vault configured?
  let hasVault = false;
  try {
    const manifest = readManifestLenient(manifestPath);
    hasVault = manifest.services.some((s) => s.name.startsWith("parachute-vault"));
  } catch {
    // Lenient reader doesn't throw on most shapes, but be defensive — a
    // malformed services.json shouldn't crash init. The wizard handles it.
    hasVault = false;
  }

  // Step 4: resolve the admin URL.
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

  // Step 5: offer to open the browser. Skip in non-TTY shells (CI),
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

/**
 * Dispatch the chosen exposure path. Returns the exit code of the
 * downstream chain. `none` is a no-op (success).
 */
async function runExposureChoice(
  choice: ExposeChoice,
  ctx: {
    log: (line: string) => void;
    exposeTailnetImpl: () => Promise<number>;
    exposeCloudflareImpl: () => Promise<number>;
  },
): Promise<number> {
  if (choice === "none") return 0;
  if (choice === "tailnet") {
    ctx.log("Setting up Tailscale Funnel…");
    return await ctx.exposeTailnetImpl();
  }
  // cloudflare
  ctx.log("Setting up Cloudflare Tunnel…");
  return await ctx.exposeCloudflareImpl();
}
