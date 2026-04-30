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
  isCloudflaredInstalled,
  isCloudflaredLoggedIn,
} from "../cloudflare/detect.ts";
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
  const proc = Bun.spawn([...cmd], { stdio: ["inherit", "inherit", "inherit"] });
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
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = (await r.prompt("Hostname (or blank to quit): ")).trim();
    if (raw === "") return undefined;
    if (isValidHostname(raw)) return raw;
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
 * Walks the user through installing and logging in cloudflared. On macOS we
 * auto-install via brew (with confirmation); on Linux we print manual-install
 * pointers and bail so the user can pick apt/dnf/tarball. Returns true only
 * when cloudflared is both present and logged in afterwards.
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
        r.log("Skipped auto-install. Install manually, then re-run: parachute expose public");
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
    } else {
      r.log("");
      r.log("Cloudflare Tunnel uses the `cloudflared` binary, which isn't installed yet.");
      r.log("Install one way:");
      r.log("  Debian / Ubuntu:");
      r.log(
        "    curl -L https://pkg.cloudflare.com/install.sh | sudo bash && sudo apt-get install -y cloudflared",
      );
      r.log("  RHEL / Fedora:");
      r.log("    sudo dnf install cloudflared");
      r.log("  Tarball / other:");
      r.log(
        "    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
      );
      r.log("");
      r.log("After install, re-run: parachute expose public");
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
      r.log("Check the browser flow completed, then re-run: parachute expose public");
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
  if (code === 0) await runPreflightSafely(r);
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
