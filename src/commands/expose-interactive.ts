/**
 * `parachute expose public` (no flags, in a TTY) — guided provider picker.
 *
 * The same command scripted (`--cloudflare --domain …` or running under a
 * non-TTY stdin) keeps today's flag-driven behavior unchanged; this module is
 * only reached via the explicit TTY+no-flags route from `cli.ts`.
 *
 * Shape mirrors `expose-cloudflare.ts`: every side-effectful edge (runner,
 * prompt, platform detection, interactive stdio commands, last-provider
 * storage) is an injectable seam so the prompt tree is testable end-to-end.
 */

import { createInterface } from "node:readline/promises";
import {
  DEFAULT_CLOUDFLARED_HOME,
  cloudflaredInstallHint,
  cloudflaredLinuxDownloadUrl,
  isCloudflaredInstalled,
  isCloudflaredLoggedIn,
} from "../cloudflare/detect.ts";
import {
  CLOUDFLARED_STATE_PATH,
  clearPendingHostname,
  readPendingHostname,
  writePendingHostname,
} from "../cloudflare/state.ts";
import {
  EXPOSE_LAST_PROVIDER_PATH,
  type ExposeProvider,
  readLastProvider,
  writeLastProvider,
} from "../expose-last-provider.ts";
import {
  type ProviderAvailability,
  detectProviders,
  isCloudflareReady,
  isTailnetReady,
} from "../providers/detect.ts";
import { type Runner, defaultRunner } from "../tailscale/run.ts";
import { type AuthPreflightOpts, runAuthPreflight } from "./expose-auth-preflight.ts";
import {
  type ExposeCloudflareOpts,
  exposeCloudflareUp,
  isValidHostname,
} from "./expose-cloudflare.ts";
import { type ExposeOpts, exposePublic } from "./expose.ts";

/**
 * Runs a command with inherited stdio, returning only the exit code. Used for
 * interactive bits like `brew install cloudflared` and `cloudflared tunnel
 * login` where we want the user to see the live output (brew progress bar,
 * the login URL cloudflared prints, etc.).
 */
export type InteractiveRunner = (cmd: readonly string[]) => Promise<number>;

const defaultInteractiveRunner: InteractiveRunner = async (cmd) => {
  // Inherit env so interactive subprocesses (e.g. `brew install cloudflared`,
  // `cloudflared tunnel login`) see PATH, HOME, etc. Bun.spawn defaults to
  // empty env — see api-modules-ops.ts:defaultRun.
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

export interface ExposeInteractiveOpts {
  runner?: Runner;
  /** Inherit-stdio runner for brew/cloudflared-login. */
  interactiveRunner?: InteractiveRunner;
  prompt?: (question: string) => Promise<string>;
  cloudflaredHome?: string;
  platform?: NodeJS.Platform;
  /** Test seam: `process.arch` — drives the Linux cloudflared download URL. */
  arch?: NodeJS.Architecture;
  /**
   * Test seam: `process.getuid` — root (uid 0) can write
   * /usr/local/bin/cloudflared directly; non-root needs `sudo`. Defaults to
   * `process.getuid` (undefined on platforms without it → treated non-root).
   */
  getuid?: () => number;
  /**
   * Path to cloudflared-state.json (hub#567 pending-hostname persistence).
   * Defaults to the canonical `CLOUDFLARED_STATE_PATH`.
   */
  statePath?: string;
  lastProviderPath?: string;
  now?: () => Date;
  log?: (line: string) => void;
  /** Passthrough opts for the Tailscale Funnel path (`exposePublic`). */
  exposeOpts?: ExposeOpts;
  /** Passthrough opts for the Cloudflare path (`exposeCloudflareUp`). */
  cloudflareOpts?: ExposeCloudflareOpts;
  /**
   * Skip the provider picker — the caller has already chosen. Used when the
   * user typed a provider flag but left a required piece out (e.g.
   * `--cloudflare` without `--domain` in a TTY): we've got their choice, we
   * just need to prompt for what's missing.
   */
  preselect?: ExposeProvider;
  /**
   * Options passed through to the post-exposure auth preflight. Set
   * `authPreflight.status` in tests to bypass the real on-disk probe; leave
   * unset in production. Only consulted when the handoff returns 0.
   */
  authPreflight?: AuthPreflightOpts;
  /**
   * Test seams for the downstream entry points — lets us exercise the
   * interactive branches without standing up a full tailscale/cloudflared
   * stub stack. Production code never sets these.
   */
  exposePublicImpl?: (action: "up" | "off", opts: ExposeOpts) => Promise<number>;
  exposeCloudflareUpImpl?: (hostname: string, opts: ExposeCloudflareOpts) => Promise<number>;
  /** Test seam for the preflight itself. Defaults to {@link runAuthPreflight}. */
  runAuthPreflightImpl?: (opts: AuthPreflightOpts) => Promise<void>;
}

interface Resolved {
  runner: Runner;
  interactiveRunner: InteractiveRunner;
  prompt: (question: string) => Promise<string>;
  cloudflaredHome: string;
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  getuid: () => number;
  statePath: string;
  lastProviderPath: string;
  now: () => Date;
  log: (line: string) => void;
  exposeOpts: ExposeOpts;
  cloudflareOpts: ExposeCloudflareOpts;
  preselect: ExposeProvider | undefined;
  authPreflight: AuthPreflightOpts;
  exposePublicImpl: (action: "up" | "off", opts: ExposeOpts) => Promise<number>;
  exposeCloudflareUpImpl: (hostname: string, opts: ExposeCloudflareOpts) => Promise<number>;
  runAuthPreflightImpl: (opts: AuthPreflightOpts) => Promise<void>;
}

function resolve(opts: ExposeInteractiveOpts): Resolved {
  return {
    runner: opts.runner ?? defaultRunner,
    interactiveRunner: opts.interactiveRunner ?? defaultInteractiveRunner,
    prompt: opts.prompt ?? defaultPrompt,
    cloudflaredHome: opts.cloudflaredHome ?? DEFAULT_CLOUDFLARED_HOME,
    platform: opts.platform ?? process.platform,
    arch: opts.arch ?? process.arch,
    // `process.getuid` is absent on Windows; treat missing as non-root (uid 1).
    getuid: opts.getuid ?? (() => process.getuid?.() ?? 1),
    statePath: opts.statePath ?? CLOUDFLARED_STATE_PATH,
    lastProviderPath: opts.lastProviderPath ?? EXPOSE_LAST_PROVIDER_PATH,
    now: opts.now ?? (() => new Date()),
    log: opts.log ?? ((line) => console.log(line)),
    exposeOpts: opts.exposeOpts ?? {},
    cloudflareOpts: opts.cloudflareOpts ?? {},
    preselect: opts.preselect,
    authPreflight: opts.authPreflight ?? {},
    exposePublicImpl: opts.exposePublicImpl ?? exposePublic,
    exposeCloudflareUpImpl: opts.exposeCloudflareUpImpl ?? exposeCloudflareUp,
    runAuthPreflightImpl: opts.runAuthPreflightImpl ?? runAuthPreflight,
  };
}

async function probeReadiness(r: Resolved): Promise<ProviderAvailability> {
  return detectProviders({ runner: r.runner, cloudflaredHome: r.cloudflaredHome });
}

type PickResult = ExposeProvider | "quit";

/**
 * Prompt loop tolerant to blank/whitespace/unexpected input: reprompts on
 * garbage rather than failing. Empty string picks the default.
 */
async function pickProvider(
  r: Resolved,
  opts: { defaultProvider: ExposeProvider; context: "both-ready" | "neither-ready" },
): Promise<PickResult> {
  const defaultLabel = opts.defaultProvider === "tailscale" ? "[1] default" : "[2] default";
  const intro =
    opts.context === "both-ready"
      ? "Which provider?"
      : "Neither Tailscale nor Cloudflare is set up. Which would you like to use?";
  r.log("");
  r.log(intro);
  r.log("  [1] Tailscale Funnel  (free, *.ts.net URL, no domain needed)");
  r.log("  [2] Cloudflare Tunnel (your own domain, Cloudflare DNS)");
  r.log(`  [q] quit              (default on enter: ${defaultLabel})`);

  // Bounded retries — a stuck prompt (non-TTY stdin that slipped through,
  // piped `/dev/null`, etc.) shouldn't spin forever.
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = (await r.prompt("> ")).trim().toLowerCase();
    if (raw === "" || raw === opts.defaultProvider[0]) return opts.defaultProvider;
    if (raw === "1" || raw === "tailscale") return "tailscale";
    if (raw === "2" || raw === "cloudflare") return "cloudflare";
    if (raw === "q" || raw === "quit" || raw === "exit") return "quit";
    r.log(`Sorry — expected 1, 2, or q (got "${raw}"). Try again.`);
  }
  r.log("Too many invalid entries; aborting.");
  return "quit";
}

async function promptHostname(r: Resolved): Promise<string | undefined> {
  r.log("");
  r.log("Cloudflare needs a hostname under a domain you've added to your Cloudflare account.");
  r.log('Example: vault.example.com   (apex "example.com" must be a Cloudflare zone)');
  // hub#567: pre-fill with a hostname the operator typed on a prior (failed)
  // run so a retry is "press Enter", not "redo the whole interview".
  const pending = readPendingHostname(r.statePath);
  const promptText = pending
    ? `Hostname [${pending}] (or blank to quit): `
    : "Hostname (or blank to quit): ";
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = (await r.prompt(promptText)).trim();
    // Enter on a pre-filled prompt accepts the stashed hostname.
    if (raw === "" && pending) {
      return pending;
    }
    if (raw === "") return undefined;
    if (isValidHostname(raw)) {
      // Stash it the moment it validates so a downstream failure (cloudflared
      // login, tunnel/DNS error) doesn't discard it. Cleared on success.
      writePendingHostname(raw, r.statePath);
      return raw;
    }
    r.log(`"${raw}" doesn't look like a hostname. Expected something like vault.example.com.`);
  }
  r.log("Too many invalid entries; aborting.");
  return undefined;
}

/**
 * Print guidance for getting Tailscale ready. We do *not* automate any of
 * this: `tailscale up` requires a browser auth flow, and the Funnel ACL is
 * an admin-console change scoped to the tailnet — the CLI impersonating
 * either would be presumptuous. User re-runs after fixing.
 */
function printTailscaleSetupGuidance(r: Resolved, readiness: ProviderAvailability): void {
  r.log("");
  r.log("Tailscale Funnel needs three things:");
  r.log("");
  if (!readiness.tailnet.available) {
    r.log("  1. Install Tailscale:");
    if (r.platform === "darwin") {
      r.log("       brew install tailscale");
    } else {
      r.log("       https://tailscale.com/download");
    }
  } else {
    r.log("  1. ✓ Tailscale is installed.");
  }
  if (!readiness.tailnet.loggedIn) {
    r.log("  2. Log this machine into your tailnet:");
    r.log("       tailscale up");
  } else {
    r.log("  2. ✓ This machine is logged in.");
  }
  if (!readiness.tailnet.funnelEnabled) {
    r.log("  3. Enable Funnel for this node in your tailnet ACLs:");
    r.log("       https://login.tailscale.com/admin/acls");
    r.log("     Add (or merge) this block under the ACL's top-level object:");
    r.log("");
    r.log('       "nodeAttrs": [');
    r.log('         { "target": ["*"], "attr": ["funnel"] }');
    r.log("       ]");
    r.log("");
    r.log("     (Scope `target` tighter — tag:server, a user, etc. — if you prefer.)");
  } else {
    r.log("  3. ✓ Funnel is enabled for this node.");
  }
  r.log("");
  r.log("Once those are done, re-run: parachute expose public");
}

/**
 * hub#566: offer to install cloudflared on Linux in place (instead of printing
 * the command and bailing). The install is a single static-binary download
 * (curl + chmod) we already know how to do.
 *
 *   - Confirm with `Install cloudflared now? [Y/n]` (Enter accepts).
 *   - Run the curl into /usr/local/bin/cloudflared + chmod +x. Root writes
 *     directly; non-root wraps each step in `sudo` (passwordless `sudo -n`
 *     succeeds non-interactively; an interactive sudo will prompt for the
 *     password under the inherit-stdio runner).
 *   - Verify with `cloudflared --version`.
 *
 * Returns true only when cloudflared is on PATH afterward. On decline, missing
 * download URL (unknown arch), or any install/verify failure, prints the
 * canonical manual instructions + the `--cloudflare` re-run hint and returns
 * false. Per hub#565 the caller's `false` does NOT abort init.
 */
async function offerLinuxCloudflaredInstall(r: Resolved): Promise<boolean> {
  r.log("");
  r.log("Cloudflare Tunnel uses the `cloudflared` binary, which isn't installed yet.");
  const downloadUrl = cloudflaredLinuxDownloadUrl(r.arch);

  const printManualAndBail = () => {
    r.log("");
    for (const line of cloudflaredInstallHint("linux", r.arch).split("\n")) r.log(line);
    r.log("");
    r.log("After install, re-run: parachute expose public --cloudflare");
  };

  // No published artifact for this arch → can't auto-install; print + bail.
  if (!downloadUrl) {
    printManualAndBail();
    return false;
  }

  const answer = (await r.prompt("Install cloudflared now? [Y/n] ")).trim().toLowerCase();
  if (answer === "n" || answer === "no") {
    r.log("Skipped auto-install.");
    printManualAndBail();
    return false;
  }

  const isRoot = r.getuid() === 0;
  const dest = "/usr/local/bin/cloudflared";
  // Root writes directly; non-root prefixes each privileged step with `sudo`.
  // `sudo` with no cached creds + no tty will fail cleanly (non-zero exit) and
  // we fall back to the printed instructions — never hang init.
  const sudo = isRoot ? [] : ["sudo"];
  const curlCmd = [...sudo, "curl", "-L", "-o", dest, downloadUrl];
  const chmodCmd = [...sudo, "chmod", "+x", dest];

  r.log("");
  r.log(`Downloading cloudflared → ${dest} …`);
  const curlCode = await r.interactiveRunner(curlCmd);
  if (curlCode !== 0) {
    r.log(`Download failed (exit ${curlCode}).`);
    if (!isRoot) r.log("(If sudo needs a password, run the commands below manually.)");
    printManualAndBail();
    return false;
  }
  const chmodCode = await r.interactiveRunner(chmodCmd);
  if (chmodCode !== 0) {
    r.log(`chmod failed (exit ${chmodCode}).`);
    printManualAndBail();
    return false;
  }

  if (!(await isCloudflaredInstalled(r.runner))) {
    r.log("Install ran but `cloudflared` still isn't on PATH.");
    r.log(
      "Open a fresh shell (so PATH picks up the new binary), then re-run: parachute expose public --cloudflare",
    );
    return false;
  }
  r.log("✓ cloudflared installed.");
  return true;
}

/**
 * Walks the user through installing and logging in cloudflared. On macOS we
 * auto-install via brew (with confirmation); on Linux we auto-install the
 * static binary (hub#566) with confirmation; everywhere else we print
 * manual-install pointers and bail. Returns true only when cloudflared is
 * both present and logged in afterwards.
 */
async function guideCloudflareSetup(
  r: Resolved,
  readiness: ProviderAvailability,
): Promise<boolean> {
  let installed = readiness.cloudflare.available;
  let loggedIn = readiness.cloudflare.loggedIn;

  if (!installed) {
    if (r.platform === "darwin") {
      r.log("");
      r.log("Cloudflare Tunnel uses the `cloudflared` binary, which isn't installed yet.");
      const answer = (await r.prompt("OK to run `brew install cloudflared`? [Y/n] "))
        .trim()
        .toLowerCase();
      if (answer === "n" || answer === "no") {
        // hub#566: re-run with `--cloudflare` (bare `expose public` defaults
        // to Tailscale Funnel, the wrong provider for someone who chose CF).
        r.log(
          "Skipped auto-install. Install manually, then re-run: parachute expose public --cloudflare",
        );
        return false;
      }
      const code = await r.interactiveRunner(["brew", "install", "cloudflared"]);
      if (code !== 0) {
        r.log(`\`brew install cloudflared\` exited ${code}. Fix the error above, then re-run.`);
        return false;
      }
      installed = await isCloudflaredInstalled(r.runner);
      if (!installed) {
        r.log("Installation reported success, but `cloudflared` still isn't on PATH.");
        r.log("Open a fresh shell (so PATH picks up the new binary) and re-run.");
        return false;
      }
    } else if (r.platform === "linux") {
      // hub#566: on Linux the install is a single static-binary download we
      // already know how to do — offer to run it in place instead of dumping
      // the operator back to a shell. Auto-install requires root (write to
      // /usr/local/bin) or a working passwordless `sudo -n`. If we can't, or
      // the operator declines, fall back to printing the instructions (and
      // per hub#565 init continues regardless of the `false` return here).
      installed = await offerLinuxCloudflaredInstall(r);
      if (!installed) return false;
    } else {
      // Non-darwin/linux (e.g. Windows / misc): no auto-install path. Print
      // the canonical pointer and bail (init continues per hub#565).
      r.log("");
      r.log("Cloudflare Tunnel uses the `cloudflared` binary, which isn't installed yet.");
      r.log("");
      for (const line of cloudflaredInstallHint(r.platform, r.arch).split("\n")) r.log(line);
      r.log("");
      // hub#566: the bare `parachute expose public` defaults to Tailscale
      // Funnel — an operator who chose Cloudflare must re-run with the flag.
      r.log("After install, re-run: parachute expose public --cloudflare");
      return false;
    }
  }

  if (!loggedIn) {
    r.log("");
    r.log("cloudflared needs to be authenticated with your Cloudflare account first.");
    r.log("The next step opens a browser so you can pick the domain to use.");
    const answer = (await r.prompt("Run `cloudflared tunnel login` now? [Y/n] "))
      .trim()
      .toLowerCase();
    if (answer === "n" || answer === "no") {
      r.log("Skipped login. Run `cloudflared tunnel login` manually, then re-run.");
      return false;
    }
    const code = await r.interactiveRunner(["cloudflared", "tunnel", "login"]);
    if (code !== 0) {
      r.log(`\`cloudflared tunnel login\` exited ${code}. Fix the error above, then re-run.`);
      return false;
    }
    loggedIn = isCloudflaredLoggedIn(r.cloudflaredHome);
    if (!loggedIn) {
      r.log("Login ran but cert.pem didn't appear in ~/.cloudflared.");
      r.log("Check the browser flow completed, then re-run: parachute expose public --cloudflare");
      return false;
    }
  }

  return true;
}

/**
 * Default provider when both are ready: prefer whatever the user picked last
 * time, falling back to Tailscale (spec: free + no domain needed — the more
 * accessible starting point).
 */
function defaultProviderFrom(lastPath: string): ExposeProvider {
  const last = readLastProvider(lastPath);
  return last?.provider ?? "tailscale";
}

export async function exposePublicInteractive(opts: ExposeInteractiveOpts = {}): Promise<number> {
  const r = resolve(opts);
  const readiness = await probeReadiness(r);
  const tsReady = isTailnetReady(readiness);
  const cfReady = isCloudflareReady(readiness);

  let provider: ExposeProvider;
  if (r.preselect) {
    // Caller passed a provider flag but is missing a required piece — skip
    // the picker entirely and resume at the setup / hostname prompt.
    provider = r.preselect;
  } else if (tsReady && cfReady) {
    const picked = await pickProvider(r, {
      defaultProvider: defaultProviderFrom(r.lastProviderPath),
      context: "both-ready",
    });
    if (picked === "quit") {
      r.log("Nothing exposed.");
      return 0;
    }
    provider = picked;
  } else if (tsReady) {
    r.log("Using Tailscale Funnel (Cloudflare Tunnel is also available with `--cloudflare`).");
    provider = "tailscale";
  } else if (cfReady) {
    r.log("Using Cloudflare Tunnel.");
    r.log("You'll need your own domain added to your Cloudflare account.");
    provider = "cloudflare";
  } else {
    const picked = await pickProvider(r, {
      defaultProvider: "tailscale",
      context: "neither-ready",
    });
    if (picked === "quit") {
      r.log("Nothing exposed.");
      return 0;
    }
    provider = picked;
  }

  if (provider === "tailscale") {
    if (!tsReady) {
      printTailscaleSetupGuidance(r, readiness);
      return 1;
    }
    writeLastProvider("tailscale", { path: r.lastProviderPath, now: r.now });
    const code = await r.exposePublicImpl("up", r.exposeOpts);
    if (code === 0) await runPreflightSafely(r);
    return code;
  }

  // Cloudflare path.
  if (!cfReady) {
    const ok = await guideCloudflareSetup(r, readiness);
    if (!ok) return 1;
  }
  const hostname = await promptHostname(r);
  if (!hostname) {
    r.log("Nothing exposed.");
    return 0;
  }
  writeLastProvider("cloudflare", { path: r.lastProviderPath, now: r.now });
  const code = await r.exposeCloudflareUpImpl(hostname, r.cloudflareOpts);
  if (code === 0) {
    // hub#567: routing succeeded — the tunnel record now carries the live
    // hostname, so drop the pending one (a retry shouldn't pre-fill a
    // hostname that's already exposed).
    clearPendingHostname(r.statePath);
    await runPreflightSafely(r);
  }
  return code;
}

/**
 * Catch anything the preflight throws and log it — the tunnel is already
 * up, so an advisory module crashing must never swallow the user's success.
 */
async function runPreflightSafely(r: Resolved): Promise<void> {
  try {
    await r.runAuthPreflightImpl(r.authPreflight);
  } catch (err) {
    r.log("");
    r.log(`(auth preflight check skipped: ${err instanceof Error ? err.message : String(err)})`);
  }
}
