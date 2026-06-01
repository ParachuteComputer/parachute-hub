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
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR, SERVICES_MANIFEST_PATH } from "../config.ts";
import { type ExposeState, readExposeState } from "../expose-state.ts";
import { type EnsureHubOpts, HUB_DEFAULT_PORT, HUB_SVC, readHubPort } from "../hub-control.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { deriveHubOrigin } from "../hub-origin.ts";
import { ensureHubUnit, installAndStartHubUnit } from "../hub-unit.ts";
import { issueOperatorToken, readOperatorTokenFile } from "../operator-token.ts";
import { type AliveFn, defaultAlive, processState } from "../process-state.ts";
import { findService, readManifestLenient } from "../services-manifest.ts";
import { listUsers } from "../users.ts";
import { type InstallOpts, install as defaultInstall } from "./install.ts";

/** The three options the exposure prompt offers — also the `--expose` flag's domain. */
export type ExposeChoice = "none" | "tailnet" | "cloudflare";

/** Where to continue setup after init finishes. CLI walks prompts in the terminal; browser opens /admin/setup. */
export type WizardChoice = "browser" | "cli";

/**
 * Outcome of the post-bringup operator-token guarantee (design §3.1):
 *   - `minted`     — no token on disk + a hub user existed → minted + wrote one.
 *   - `present`    — a token already existed on disk → left it alone.
 *   - `no-user`    — no token + no hub user yet (fresh box pre-wizard); the
 *                    wizard's account step will mint it. NOT an error.
 *   - `mint-failed`— a mint was attempted but failed (DB unavailable, etc.);
 *                    non-fatal — the wizard / `auth rotate-operator` can retry.
 */
export type OperatorTokenGuaranteeStatus = "minted" | "present" | "no-user" | "mint-failed";

export interface InitOpts {
  configDir?: string;
  manifestPath?: string;
  log?: (line: string) => void;
  /** Test seam: `processState` liveness check. */
  alive?: AliveFn;
  /**
   * Hub-bringup shim. Phase 3a cutover: production now INSTALLS + STARTS the
   * hub *unit* (launchd on Mac, systemd on Linux) via `installAndStartHubUnit`
   * and waits for readiness — it no longer spawns a detached `bun hub-server.ts`
   * (`defaultEnsureHubViaUnit`). The return shape (`{ pid, port, started }`) is
   * preserved so the downstream init flow (URL resolution, wizard hand-off) is
   * unchanged; `pid` is `0` on the unit path (a unit-managed hub has no
   * pidfile). Tests pass a stub that records the call without touching the OS.
   * Design §3.3 (init row), §4.1/§4.2, appendix (c).
   */
  ensureHub?: (opts: EnsureHubOpts) => Promise<{ pid: number; port: number; started: boolean }>;
  /**
   * Test seam: guarantee an operator token exists once the hub is up (design
   * §3.1 / §3.3). Production reads `operator.token`; if absent AND a hub user
   * already exists, it mints + writes one so a later per-module verb never
   * 401s. Returns a short status so init can log what happened. Tests stub it
   * to assert the mint-when-absent / skip-when-present behavior without a DB.
   */
  guaranteeOperatorToken?: (ctx: {
    configDir: string;
    hubPort: number;
    log: (line: string) => void;
  }) => Promise<OperatorTokenGuaranteeStatus>;
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
  /**
   * Test seam: shim for the vault-module install step (hub#168 Cut 1).
   * Production calls `install("vault", { noCreate: true, noStart: true, …})`
   * to put `@openparachute/vault` on PATH without creating a first-vault
   * instance — the wizard's vault step decides Create/Import/Skip. Tests
   * pass a stub to record the call without shelling out.
   */
  installVaultModuleImpl?: (configDir: string, manifestPath: string) => Promise<number>;
  /**
   * Override the wizard-choice prompt (hub#168 Cut 4). When set, the
   * "Continue setup in the browser or CLI?" question is answered without
   * a prompt; otherwise default is `browser`. Non-interactive shells
   * (`!isTty`) skip the prompt entirely and print the admin URL.
   */
  wizardChoice?: WizardChoice;
  /**
   * Test seam: shim for the CLI wizard chain (hub#168 Cut 3). Production
   * lazy-imports `runCliWizard` from `./wizard.ts`. Tests pass a stub.
   */
  runCliWizardImpl?: (opts: { hubUrl: string; log: (l: string) => void }) => Promise<number>;
  /**
   * Skip the "browser or CLI?" wizard-choice prompt (hub#168 Cut 4). Used
   * by pre-Cut-4 tests that don't expect the new prompt + by the
   * `--no-browser` / explicit-`--cli-wizard` paths (where the answer is
   * already known so there's no question to ask).
   */
  noWizardPrompt?: boolean;
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
  // WSL2 is Linux + headless from $DISPLAY's perspective but is in fact a
  // developer's laptop. Detect via WSL-specific env vars (set in every WSL
  // distro) so we don't pre-select Cloudflare for someone running Parachute
  // inside WSL on Windows. Reviewer-flagged on #445.
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return false;
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return true;
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return true;
  return false;
}

/**
 * Heuristic: would a browser-spawn fail because there's no display?
 *
 * A TTY guard alone is insufficient — an SSH session is a TTY with no display,
 * so `xdg-open` fails (or blocks). We treat a box as display-less when:
 *   - it's a server per {@link looksLikeServer} (linux + SSH or no X/Wayland,
 *     excluding WSL which is a dev laptop), OR
 *   - it's linux with neither $DISPLAY nor $WAYLAND_DISPLAY (covers a local
 *     headless linux console that isn't over SSH).
 *
 * macOS / Windows always have a window server, so they're never display-less
 * here (someone SSH'd into a Mac is a rare enough edge that we keep the happy
 * path — `open` no-ops gracefully there anyway).
 */
export function hasNoDisplay(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  if (platform !== "linux") return false;
  if (looksLikeServer(platform, env)) return true;
  return !env.DISPLAY && !env.WAYLAND_DISPLAY;
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
 * Absolute path to this hub checkout's `src/cli.ts` — the entry the hub unit's
 * `ExecStart`/`ProgramArguments` runs `serve` against. Resolved from
 * `import.meta.url` (this file is `src/commands/init.ts`, so `cli.ts` is one
 * directory up). On the bun-linked dev path this points into the checkout; on
 * an npm install it points into the installed package — either way the unit
 * runs the same on-disk entry the operator is invoking right now.
 */
function defaultHubCliPath(): string {
  return fileURLToPath(new URL("../cli.ts", import.meta.url));
}

/**
 * Production hub-bringup for the Phase 3a cutover (design §3.3 init row,
 * appendix c). REPLACES the detached `ensureHubRunning` spawn:
 *
 *   1. Probe the loopback hub. If it already answers, return started:false
 *      WITHOUT touching the unit (init is idempotent — a re-run against a live
 *      hub shouldn't reinstall/restart it).
 *   2. Otherwise INSTALL + START the hub unit via `installAndStartHubUnit`:
 *      `buildHubManagedUnit` captures the operator's CURRENT `PARACHUTE_HOME`
 *      (§4.2 — derived from the resolved `configDir`, not the hard-coded
 *      default), resolves abs bun + the abs cli.ts entry, launchd-by-default on
 *      Mac (D2) / systemd-system-if-root-else-user+linger on Linux. Then waits
 *      for hub readiness, surfacing the unit log on timeout (§3.2 step 5).
 *   3. On a host with NO service manager (container / init-less), throw an
 *      actionable error — the container runtime CMD is `serve`, not `init`
 *      (§3.2 step 4). NEVER fall back to a detached spawn.
 *
 * Returns the `{ pid, port, started }` shape init's downstream flow expects;
 * `pid` is `0` because a unit-managed hub has no pidfile (the platform manager
 * owns the process).
 */
async function defaultEnsureHubViaUnit(opts: EnsureHubOpts): Promise<{
  pid: number;
  port: number;
  started: boolean;
}> {
  const configDir = opts.configDir ?? CONFIG_DIR;
  const port = opts.startPort ?? HUB_DEFAULT_PORT;
  const log = opts.log ?? (() => {});

  // First try the lighter ensure-path (§3.2): probe /health → if up, done with
  // no install; if a unit is already installed but down, just start it. This
  // keeps a re-run of `init` idempotent — it won't pointlessly rewrite the unit
  // file when the hub is already answering or the unit already exists.
  const ensured = await ensureHubUnit({ port, log });
  if (ensured.outcome === "already-up") {
    return { pid: 0, port: ensured.port, started: false };
  }
  if (ensured.outcome === "started") {
    return { pid: 0, port: ensured.port, started: true };
  }
  if (ensured.outcome === "no-manager") {
    // Container / init-less host — can't host a unit. Foreground `serve` is the
    // runtime here, not `init` (§3.2 step 4). Surface + bail; never spawn.
    throw new Error(ensured.messages.join("\n"));
  }
  // `no-unit` (the fresh-box case init exists to handle) → INSTALL + start the
  // unit, then wait for readiness (§3.3 init row, §4.1/§4.2). `start-failed` /
  // `timeout` from the start-existing-unit path also fall through to a clean
  // (re)install attempt here — overwriting the unit file is idempotent.
  const result = await installAndStartHubUnit({
    // Capture the operator's CURRENT PARACHUTE_HOME (the resolved configDir),
    // NOT the hard-coded default (§4.2).
    parachuteHome: configDir,
    cliPath: defaultHubCliPath(),
    port,
    log,
  });

  if (result.outcome === "started") {
    return { pid: 0, port: result.port, started: true };
  }
  if (result.outcome === "already-up") {
    return { pid: 0, port: result.port, started: false };
  }
  // no-manager / timeout / start-failed → actionable error. The init caller
  // catches this and prints the message + `parachute logs hub` hint.
  throw new Error(result.messages.join("\n") || `hub unit bringup failed (${result.outcome}).`);
}

/**
 * Resolve the issuer to mint the operator token under. At init time the hub is
 * reachable on loopback (just installed); prefer the live expose-state origin
 * (rare during init, but honored if a prior `expose` ran), else the loopback
 * origin. Mirrors `commands/auth.ts`'s `resolveHubIssuer` so a token minted at
 * init validates the same way one minted by `auth rotate-operator` would.
 */
function resolveInitIssuer(configDir: string, hubPort: number): string {
  const state = readExposeState(join(configDir, "expose-state.json"));
  if (state?.hubOrigin) return state.hubOrigin;
  return (
    deriveHubOrigin({ exposeFqdn: state?.canonicalFqdn, hubPort }) ?? `http://127.0.0.1:${hubPort}`
  );
}

/**
 * Production operator-token guarantee (design §3.1 / §3.3). Under the unified
 * model every per-module verb is an authenticated module-ops call, so the
 * steady-state operator needs an `operator.token` on disk. init guarantees it:
 *
 *   - Token already on disk → leave it (`present`). The hub remains the sole
 *     minter; we never mint-in-parallel (§3.1).
 *   - No token + a hub user already exists → mint under the default (`admin`)
 *     scope-set + write it 0600 (`minted`).
 *   - No token + no hub user yet (the common fresh-box case — init runs BEFORE
 *     the wizard creates first-admin) → `no-user`. NOT an error: the wizard's
 *     account step / `auth set-password` mints it once the admin exists.
 *
 * Failures are non-fatal (`mint-failed`): a DB hiccup shouldn't block init when
 * the wizard or `auth rotate-operator` can retry.
 */
async function defaultGuaranteeOperatorToken(ctx: {
  configDir: string;
  hubPort: number;
  log: (line: string) => void;
}): Promise<OperatorTokenGuaranteeStatus> {
  const existing = await readOperatorTokenFile(ctx.configDir);
  if (existing) return "present";

  const db = openHubDb(hubDbPath(ctx.configDir));
  try {
    const owner = listUsers(db)[0];
    if (!owner) {
      // Fresh box: no first-admin yet. The wizard mints the token when it
      // creates the admin. Nothing to do here, and definitely not an error.
      return "no-user";
    }
    const issued = await issueOperatorToken(db, owner.id, {
      dir: ctx.configDir,
      issuer: resolveInitIssuer(ctx.configDir, ctx.hubPort),
    });
    ctx.log(`✓ Operator token written to ${issued.path} (mode 0600).`);
    return "minted";
  } catch (err) {
    ctx.log(
      `⚠ Couldn't mint an operator token (${
        err instanceof Error ? err.message : String(err)
      }); run \`parachute auth rotate-operator\` later if a CLI command reports a missing token.`,
    );
    return "mint-failed";
  } finally {
    db.close();
  }
}

/**
 * Default impl for the vault-module install step (hub#168 Cut 1). Calls
 * install("vault", { noCreate: true, noStart: true, …}) with a quiet log
 * shim that re-emits each line under an `[install vault] ` prefix so the
 * init log stays grep-able. Idempotent — `install` short-circuits the
 * bun-add when vault is already linked / installed.
 */
async function defaultInstallVaultModule(configDir: string, manifestPath: string): Promise<number> {
  const installOpts: InstallOpts = {
    configDir,
    manifestPath,
    noCreate: true,
    noStart: true,
    log: (line) => console.log(`[install vault] ${line}`),
  };
  return await defaultInstall("vault", installOpts);
}

/**
 * Default impl for the CLI wizard chain (hub#168 Cut 3). Lazy-imports
 * `runCliWizard` from `./wizard.ts`. Tests pass a stub via
 * `runCliWizardImpl` rather than triggering the real HTTP-to-localhost
 * flow.
 */
async function defaultRunCliWizard(opts: {
  hubUrl: string;
  log: (l: string) => void;
}): Promise<number> {
  const { runCliWizard } = await import("./wizard.ts");
  return await runCliWizard(opts);
}

/**
 * Prompt for the wizard-choice question (hub#168 Cut 4). Returns the
 * picked option, or `undefined` if the operator quit. Default is
 * `browser` because (a) the browser flow is the canonical post-launch
 * experience, and (b) it works without re-asking the operator about
 * their password aloud on the terminal.
 */
async function promptWizardChoice(
  prompt: (q: string) => Promise<string>,
  log: (line: string) => void,
): Promise<WizardChoice | undefined> {
  log("Continue setup here in the CLI, or in your browser?");
  log("  1) Browser (opens /admin/setup) (default)");
  log("  2) CLI (walks you through it in this terminal)");
  log("");
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = (await prompt("Pick [1]: ")).trim().toLowerCase();
    if (raw === "") return "browser";
    if (raw === "1" || raw === "browser" || raw === "b") return "browser";
    if (raw === "2" || raw === "cli" || raw === "c") return "cli";
    if (raw === "q" || raw === "quit" || raw === "exit") return undefined;
    log(`Sorry — expected 1, 2, or q (got "${raw}"). Try again.`);
  }
  log("Too many invalid entries; defaulting to browser.");
  return "browser";
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
  log(`  1) No — keep it loopback-only${mark("none")}`);
  log(`  2) Yes, private to your tailnet (Tailscale \`serve\`)${mark("tailnet")}`);
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
  // Phase 3a cutover: production installs + starts the hub UNIT (not a detached
  // spawn). The `ensureHub` seam is preserved for tests (and the return shape is
  // unchanged); only the production default flipped.
  const ensureHub = opts.ensureHub ?? defaultEnsureHubViaUnit;
  const guaranteeOperatorToken = opts.guaranteeOperatorToken ?? defaultGuaranteeOperatorToken;
  const readExposeStateFn = opts.readExposeStateFn ?? (() => readExposeState());
  const isTty = opts.isTty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const prompt = opts.prompt ?? defaultPrompt;
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const openBrowser = opts.openBrowser ?? ((url: string) => defaultOpenBrowser(url, platform));
  const exposeTailnetImpl = opts.exposeTailnetImpl ?? defaultExposeTailnet;
  const exposeCloudflareImpl = opts.exposeCloudflareImpl ?? defaultExposeCloudflare;
  const installVaultModuleImpl = opts.installVaultModuleImpl ?? defaultInstallVaultModule;
  const runCliWizardImpl = opts.runCliWizardImpl ?? defaultRunCliWizard;

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

  // Step 1.5: guarantee an operator token exists (design §3.1 / §3.3). Under
  // the unified model every per-module verb is an authenticated module-ops
  // call, so the steady-state operator needs an `operator.token` on disk — the
  // mint-on-init guarantee closes the bootstrap so a later verb never 401s.
  // On a fresh box (no first-admin yet) this is a no-op (`no-user`): the wizard
  // mints it when it creates the admin. Non-fatal either way — init continues
  // to the wizard regardless.
  await guaranteeOperatorToken({ configDir, hubPort, log });

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

  // Step 2.5: always install the vault module (hub#168 Cut 1). Aaron's
  // 2026-05-28 directive: "it should always install the vault module"
  // even though "creating a vault should be optional." We split the
  // module install (always) from the first-vault create (deferred to
  // the wizard) by passing `noCreate: true` to install — bun add -g
  // runs, services.json gets seeded, but `parachute-vault init` (which
  // would auto-create a `default` vault) is skipped. The wizard's
  // vault step then either Creates / Imports / Skips.
  //
  // Idempotent: install short-circuits the bun-add when vault is
  // already linked (`bun link`) or already globally installed. If the
  // operator already has a vault row, this is a no-op past the
  // already-installed log line. We don't block init on this step;
  // a non-zero exit code is logged but treated as a warning, since the
  // wizard can re-attempt the install itself from /admin/setup.
  const findVaultEntry = (): boolean => {
    try {
      return findService("parachute-vault", manifestPath) !== undefined;
    } catch {
      return false;
    }
  };
  const vaultAlreadyInstalled = findVaultEntry();
  if (!vaultAlreadyInstalled) {
    log("");
    log("Installing the vault module so the wizard can offer create / import / skip…");
    const installCode = await installVaultModuleImpl(configDir, manifestPath);
    if (installCode !== 0) {
      log(
        `⚠ vault module install returned ${installCode}; the wizard can retry from /admin/setup.`,
      );
    }
  }

  // Step 3: vault configured? (After the module install above, this may
  // have flipped from false to true on a fresh box. The wizard reads
  // services.json on every request, so the "configured" answer here is
  // best-effort — it only shapes the next-step log message below.)
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

  // Step 4.5: offer the operator the CLI wizard vs. the browser wizard
  // (hub#168 Cut 4). Aaron's 2026-05-28 directive: "we should be able to
  // move through a setup wizard on the command line or (and this is the
  // default experience) run it through on the web." Browser remains the
  // default — the in-terminal CLI walk is opt-in (`2)` at the prompt,
  // `--cli-wizard` flag non-interactively).
  //
  // The CLI wizard chain only fires when:
  //   - explicit `wizardChoice === "cli"` (flag-driven), or
  //   - interactive TTY + the operator picked CLI at the prompt.
  //
  // In every other case (non-TTY, --no-browser, explicit
  // `wizardChoice === "browser"`, or interactive default), we fall
  // through to the existing browser-open flow below.
  let choice: WizardChoice | undefined = opts.wizardChoice;
  // `noWizardPrompt` (or pre-existing `noExposePrompt` for back-compat
  // with the smaller pre-hub#168 test surface) suppresses the
  // browser-or-CLI question. Tests written before Cut 4 don't expect a
  // new prompt; without this flag they would see the wizard-choice
  // prompt fire and timeout on a `'n'` answer (which means "no" to the
  // historical Y/n browser-open confirm, not "exit" to the new prompt).
  if (choice === undefined && isTty && !opts.noBrowser && !opts.noWizardPrompt) {
    log("");
    choice = await promptWizardChoice(prompt, log);
  }
  if (choice === "cli") {
    log("");
    log("Launching the CLI wizard. (You can also visit the URL above in a browser any time.)");
    return await runCliWizardImpl({ hubUrl: adminUrl.replace(/\/admin\/?$/, ""), log });
  }

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
  // Headless guard: a TTY isn't enough — an SSH session is a TTY but has no
  // display, so `xdg-open` either fails noisily or (worse) blocks. Skip the
  // spawn entirely on a server-shaped box (linux + no $DISPLAY/$WAYLAND_DISPLAY,
  // or SSH) and just print the link. Aaron hit this on EC2: init tried to open
  // a browser, failed with "Couldn't launch a browser," and (pre-Fix-1) showed
  // the loopback URL. With Fix 1 the printed link is now the public Cloudflare
  // URL. Keep spawning on a real desktop (macOS, Linux-with-display).
  if (hasNoDisplay(platform, env)) {
    log("(No display detected — open the URL above in a browser to continue.)");
    return 0;
  }
  // `choice === "browser"` (either flag-driven or the operator picked
  // browser at the prompt) goes straight to openBrowser — skip the
  // back-compat "Open in your browser now?" Y/n confirm. If choice is
  // undefined (no prompt, no flag), keep the historical Y/n confirm
  // for back-compat with existing tests + scripted callers.
  if (choice !== "browser") {
    const answer = (await prompt("Open in your browser now? [Y/n] ")).trim().toLowerCase();
    if (answer === "n" || answer === "no") return 0;
  }
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
    ctx.log("Setting up private tailnet access (Tailscale `serve`)…");
    return await ctx.exposeTailnetImpl();
  }
  // cloudflare
  ctx.log("Setting up Cloudflare Tunnel…");
  return await ctx.exposeCloudflareImpl();
}
