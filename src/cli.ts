#!/usr/bin/env bun

/**
 * parachute — the top-level CLI for the Parachute ecosystem.
 *
 * Run `parachute --help` or `parachute <subcommand> --help` for usage.
 */

import pkg from "../package.json" with { type: "json" };
import { CloudflaredStateError } from "./cloudflare/state.ts";
import { auth } from "./commands/auth.ts";
import { exposePublic, exposeTailnet } from "./commands/expose.ts";
import { install } from "./commands/install.ts";
import { logs, restart, start, stop } from "./commands/lifecycle.ts";
import { migrate } from "./commands/migrate.ts";
import { serve } from "./commands/serve.ts";
import { setup } from "./commands/setup.ts";
import { status } from "./commands/status.ts";
import { upgrade } from "./commands/upgrade.ts";
import { dispatchVault } from "./commands/vault.ts";
import { ExposeStateError } from "./expose-state.ts";
import {
  exposeHelp,
  installHelp,
  logsHelp,
  migrateHelp,
  restartHelp,
  serveHelp,
  setupHelp,
  startHelp,
  statusHelp,
  stopHelp,
  topLevelHelp,
  upgradeHelp,
} from "./help.ts";
import { HUB_SVC } from "./hub-control.ts";
import { knownServices } from "./service-spec.ts";
import { ServicesManifestError } from "./services-manifest.ts";
import { TailscaleError } from "./tailscale/run.ts";

function isHelpFlag(arg: string | undefined): boolean {
  return arg === "--help" || arg === "-h" || arg === "help";
}

/**
 * Both stdin and stdout must be TTYs before we offer interactive prompts.
 * Stdin-only TTY would let us read keystrokes but leave prompt text going to
 * a log file; stdout-only TTY would let us write prompts but never read an
 * answer. Either asymmetry means the flag-driven path is the safer default.
 */
function isTtyInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Extract `--hub-origin=<url>` / `--hub-origin <url>` from argv. Returns the
 * URL and the remaining args (so callers can keep validating positionals
 * without the flag in the way). `error` is set on missing value.
 */
function extractHubOrigin(args: string[]): {
  hubOrigin?: string;
  rest: string[];
  error?: string;
} {
  const rest: string[] = [];
  let hubOrigin: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--hub-origin") {
      const v = args[i + 1];
      if (!v) return { rest, error: "--hub-origin requires a URL argument" };
      hubOrigin = v;
      i++;
      continue;
    }
    if (a?.startsWith("--hub-origin=")) {
      hubOrigin = a.slice("--hub-origin=".length);
      if (!hubOrigin) return { rest, error: "--hub-origin requires a URL argument" };
      continue;
    }
    if (a !== undefined) rest.push(a);
  }
  return { hubOrigin, rest };
}

/**
 * Extract `--tag=<value>` / `--tag <value>` from argv. Same shape as
 * `extractHubOrigin` so the install command can layer the two flags
 * uniformly. `error` is set on missing value.
 */
function extractTag(args: string[]): {
  tag?: string;
  rest: string[];
  error?: string;
} {
  const rest: string[] = [];
  let tag: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--tag") {
      const v = args[i + 1];
      if (!v) return { rest, error: "--tag requires a value (dist-tag or version)" };
      tag = v;
      i++;
      continue;
    }
    if (a?.startsWith("--tag=")) {
      tag = a.slice("--tag=".length);
      if (!tag) return { rest, error: "--tag requires a value (dist-tag or version)" };
      continue;
    }
    if (a !== undefined) rest.push(a);
  }
  return { tag, rest };
}

/**
 * Generic `--name=<value>` / `--name <value>` extractor used for the scribe
 * install flags. Returns the matched value and argv with the flag stripped, or
 * an error when the flag is present without a value.
 */
function extractNamedFlag(
  args: string[],
  flag: string,
): { value?: string; rest: string[]; error?: string } {
  const rest: string[] = [];
  let value: string | undefined;
  const eqPrefix = `${flag}=`;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === flag) {
      const v = args[i + 1];
      if (!v) return { rest, error: `${flag} requires a value` };
      value = v;
      i++;
      continue;
    }
    if (a?.startsWith(eqPrefix)) {
      value = a.slice(eqPrefix.length);
      if (!value) return { rest, error: `${flag} requires a value` };
      continue;
    }
    if (a !== undefined) rest.push(a);
  }
  return { value, rest };
}

/**
 * Extract every `parachute expose …` provider flag in one pass:
 *
 *   --cloudflare              boolean — pin to Cloudflare Tunnel
 *   --tailnet                 boolean — pin to Tailscale Funnel (#29)
 *   --skip-provider-check     boolean — bypass auto-detection in non-TTY,
 *                                       fall through to today's Tailscale
 *                                       default (CI escape hatch, #29)
 *   --domain=<host>           hostname for the Cloudflare path
 *   --tunnel-name=<name>      named tunnel override (#32)
 *
 * Returns the stripped argv so the layer/action parser sees `[layer, action?]`
 * regardless of flag placement. `--tailnet` + `--cloudflare` together is
 * caller-rejected; this extractor doesn't enforce mutual exclusion so help-
 * driven error messages can stay close to the dispatch site.
 */
function extractExposeProviderFlags(args: string[]): {
  cloudflare: boolean;
  tailnet: boolean;
  skipProviderCheck: boolean;
  domain?: string;
  tunnelName?: string;
  rest: string[];
  error?: string;
} {
  const rest: string[] = [];
  let cloudflare = false;
  let tailnet = false;
  let skipProviderCheck = false;
  let domain: string | undefined;
  let tunnelName: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--cloudflare") {
      cloudflare = true;
      continue;
    }
    if (a === "--tailnet" || a === "--tailscale") {
      tailnet = true;
      continue;
    }
    if (a === "--skip-provider-check") {
      skipProviderCheck = true;
      continue;
    }
    if (a === "--domain") {
      const v = args[i + 1];
      if (!v) {
        return {
          cloudflare,
          tailnet,
          skipProviderCheck,
          rest,
          error: "--domain requires a hostname argument",
        };
      }
      domain = v;
      i++;
      continue;
    }
    if (a?.startsWith("--domain=")) {
      domain = a.slice("--domain=".length);
      if (!domain) {
        return {
          cloudflare,
          tailnet,
          skipProviderCheck,
          rest,
          error: "--domain requires a hostname argument",
        };
      }
      continue;
    }
    if (a === "--tunnel-name") {
      const v = args[i + 1];
      if (!v) {
        return {
          cloudflare,
          tailnet,
          skipProviderCheck,
          rest,
          error: "--tunnel-name requires a name argument",
        };
      }
      tunnelName = v;
      i++;
      continue;
    }
    if (a?.startsWith("--tunnel-name=")) {
      tunnelName = a.slice("--tunnel-name=".length);
      if (!tunnelName) {
        return {
          cloudflare,
          tailnet,
          skipProviderCheck,
          rest,
          error: "--tunnel-name requires a name argument",
        };
      }
      continue;
    }
    if (a !== undefined) rest.push(a);
  }
  const out: {
    cloudflare: boolean;
    tailnet: boolean;
    skipProviderCheck: boolean;
    domain?: string;
    tunnelName?: string;
    rest: string[];
  } = {
    cloudflare,
    tailnet,
    skipProviderCheck,
    rest,
  };
  if (domain !== undefined) out.domain = domain;
  if (tunnelName !== undefined) out.tunnelName = tunnelName;
  return out;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(topLevelHelp());
      return 0;

    case "--version":
    case "-v":
      console.log(pkg.version);
      return 0;

    case "setup": {
      if (isHelpFlag(rest[0])) {
        console.log(setupHelp());
        return 0;
      }
      const tagExtract = extractTag(rest);
      if (tagExtract.error) {
        console.error(`parachute setup: ${tagExtract.error}`);
        return 1;
      }
      const noStart = tagExtract.rest.includes("--no-start");
      const remaining = tagExtract.rest.filter((a) => a !== "--no-start");
      if (remaining.length > 0) {
        console.error(`parachute setup: unknown argument "${remaining[0]}"`);
        console.error("usage: parachute setup [--tag <name>] [--no-start]");
        return 1;
      }
      const setupOpts: Parameters<typeof setup>[0] = {};
      if (tagExtract.tag) setupOpts.tag = tagExtract.tag;
      if (noStart) setupOpts.noStart = true;
      return await setup(setupOpts);
    }

    case "install": {
      if (isHelpFlag(rest[0])) {
        console.log(installHelp());
        return 0;
      }
      const tagExtract = extractTag(rest);
      if (tagExtract.error) {
        console.error(`parachute install: ${tagExtract.error}`);
        return 1;
      }
      const providerExtract = extractNamedFlag(tagExtract.rest, "--scribe-provider");
      if (providerExtract.error) {
        console.error(`parachute install: ${providerExtract.error}`);
        return 1;
      }
      const keyExtract = extractNamedFlag(providerExtract.rest, "--scribe-key");
      if (keyExtract.error) {
        console.error(`parachute install: ${keyExtract.error}`);
        return 1;
      }
      const noStart = keyExtract.rest.includes("--no-start");
      const installArgs = keyExtract.rest.filter((a) => a !== "--no-start");
      const service = installArgs[0];
      if (!service) {
        console.error("usage: parachute install <service|all> [--tag <name>] [--no-start]");
        console.error(
          "       parachute install scribe [--scribe-provider <name>] [--scribe-key <key>]",
        );
        console.error(`services: ${knownServices().join(", ")}`);
        return 1;
      }
      const installOpts: Parameters<typeof install>[1] = {};
      if (tagExtract.tag) installOpts.tag = tagExtract.tag;
      if (noStart) installOpts.noStart = true;
      if (providerExtract.value) installOpts.scribeProvider = providerExtract.value;
      if (keyExtract.value) installOpts.scribeKey = keyExtract.value;
      if (service === "all") {
        // Bootstrap the whole ecosystem to one dist-tag — the RC-testing payload.
        // Bail on first failure so a broken channel doesn't mask a working tag.
        for (const svc of knownServices()) {
          const code = await install(svc, installOpts);
          if (code !== 0) return code;
        }
        return 0;
      }
      return await install(service, installOpts);
    }

    case "status":
      if (isHelpFlag(rest[0])) {
        console.log(statusHelp());
        return 0;
      }
      return await status();

    case "expose": {
      const hubExtract = extractHubOrigin(rest);
      if (hubExtract.error) {
        console.error(`parachute expose: ${hubExtract.error}`);
        return 1;
      }
      const flagExtract = extractExposeProviderFlags(hubExtract.rest);
      if (flagExtract.error) {
        console.error(`parachute expose: ${flagExtract.error}`);
        return 1;
      }
      if (flagExtract.cloudflare && flagExtract.tailnet) {
        console.error(
          "parachute expose: --tailnet and --cloudflare are mutually exclusive. Pick one.",
        );
        return 1;
      }
      const exposeArgs = flagExtract.rest;
      const layer = exposeArgs[0];
      const mode = exposeArgs[1];
      if (isHelpFlag(layer)) {
        console.log(exposeHelp());
        return 0;
      }
      if (layer !== "tailnet" && layer !== "public") {
        console.error(`parachute expose: unknown layer "${layer ?? ""}"`);
        console.error("usage: parachute expose tailnet [off]");
        console.error("       parachute expose public  [off]");
        console.error("       parachute expose public --cloudflare --domain <hostname>");
        console.error("run `parachute expose --help` for details");
        return 1;
      }
      if (isHelpFlag(mode)) {
        console.log(exposeHelp());
        return 0;
      }
      if (mode !== undefined && mode !== "off") {
        console.error(`parachute expose ${layer}: unknown argument "${mode}"`);
        console.error(`usage: parachute expose ${layer} [off]`);
        return 1;
      }
      const action = mode === "off" ? "off" : "up";

      if (flagExtract.tailnet && layer !== "public") {
        console.error(
          "parachute expose: --tailnet pins the public layer to Tailscale Funnel; it doesn't apply to `expose tailnet`.",
        );
        return 1;
      }

      // Cloudflare mode is a separate execution path — different detector,
      // different state file, different process model (it spawns cloudflared
      // rather than driving tailscale serve/funnel). Route to it early.
      if (flagExtract.cloudflare) {
        if (layer !== "public") {
          console.error(
            "parachute expose: --cloudflare only applies to `public` (it's a public-internet path).",
          );
          return 1;
        }
        const { exposeCloudflareUp, exposeCloudflareOff } = await import(
          "./commands/expose-cloudflare.ts"
        );
        const cfOpts = flagExtract.tunnelName ? { tunnelName: flagExtract.tunnelName } : {};
        if (action === "off") {
          return await exposeCloudflareOff(cfOpts);
        }
        if (!flagExtract.domain) {
          // Partial flag promotion: the user told us they want Cloudflare but
          // didn't supply a hostname. In a TTY, prompt only for what's
          // missing instead of forcing them to retype the whole command. In a
          // non-TTY (scripts, CI), keep today's hard-error so automation
          // doesn't block on an invisible prompt.
          if (isTtyInteractive()) {
            const { exposePublicInteractive } = await import("./commands/expose-interactive.ts");
            return await exposePublicInteractive({ preselect: "cloudflare" });
          }
          console.error("parachute expose public --cloudflare: --domain <hostname> is required.");
          console.error("Example: parachute expose public --cloudflare --domain vault.example.com");
          console.error("");
          console.error("The hostname's apex domain must already be a zone on your Cloudflare");
          console.error(
            "account. If you don't have one yet: https://dash.cloudflare.com → Add site.",
          );
          console.error("");
          console.error("If you'd rather not own a domain, use Tailscale Funnel instead:");
          console.error("  parachute expose public");
          return 1;
        }
        return await exposeCloudflareUp(flagExtract.domain, cfOpts);
      }

      const exposeOpts = hubExtract.hubOrigin ? { hubOrigin: hubExtract.hubOrigin } : {};

      // `--tailnet` is the explicit Tailscale Funnel pin — bypass both the
      // interactive picker and the non-TTY auto-pick. Goes straight to
      // exposePublic so today's Funnel flow keeps working unchanged.
      if (layer === "public" && action === "up" && flagExtract.tailnet) {
        return await exposePublic("up", exposeOpts);
      }

      // Interactive picker: `parachute expose public` with no provider flags,
      // running under a TTY on both stdin and stdout, routes through a guided
      // flow that offers Tailscale vs. Cloudflare, walks provider setup, and
      // hands back to the flag-driven entry points.
      if (layer === "public" && action === "up" && isTtyInteractive()) {
        const { exposePublicInteractive } = await import("./commands/expose-interactive.ts");
        return await exposePublicInteractive({ exposeOpts });
      }

      // Non-TTY auto-pick: detect which provider is configured and run it.
      // `--skip-provider-check` (CI escape hatch) skips detection and falls
      // through to today's Tailscale-Funnel default — useful when the
      // environment is already pre-flighted and the auto-pick would just
      // print noise. Both paths run only on `expose public up`; tailnet
      // exposure has only one provider so nothing to pick.
      //
      // `domain` and `tunnelName` are deliberately *not* threaded into
      // auto-pick. Both are Cloudflare-only flags; if a user passes them
      // without `--cloudflare`, threading would silently route them to
      // Cloudflare. Better to drop the flags here and let auto-pick decide
      // purely from what's installed — if it lands on cloudflare-only-ready,
      // it prints the explicit `--cloudflare --domain` hint instead of
      // guessing intent.
      if (layer === "public" && action === "up" && !flagExtract.skipProviderCheck) {
        const { exposePublicAutoPick } = await import("./commands/expose-public-auto.ts");
        return await exposePublicAutoPick({ tailscaleOpts: exposeOpts });
      }

      // `expose public off` (no `--cloudflare`) auto-detects which provider is
      // live. The explicit `--cloudflare` off branch above still wins — this
      // path is only for users who typed plain `off` and don't want to
      // remember which provider they brought up last.
      if (layer === "public" && action === "off") {
        const { runExposePublicOffAutoDetect } = await import("./commands/expose-off-auto.ts");
        return await runExposePublicOffAutoDetect({ tailscaleOffOpts: exposeOpts });
      }

      // `--skip-provider-check` fallthrough: pin to today's Tailscale-Funnel
      // default for `expose public up`. Made explicit (rather than letting
      // it tumble through the layer ternary) so the escape-hatch branch is
      // visible at a glance.
      if (layer === "public" && action === "up" && flagExtract.skipProviderCheck) {
        return await exposePublic("up", exposeOpts);
      }

      return await exposeTailnet(action, exposeOpts);
    }

    case "start": {
      if (isHelpFlag(rest[0])) {
        console.log(startHelp());
        return 0;
      }
      const hubExtract = extractHubOrigin(rest);
      if (hubExtract.error) {
        console.error(`parachute start: ${hubExtract.error}`);
        return 1;
      }
      const startOpts = hubExtract.hubOrigin ? { hubOrigin: hubExtract.hubOrigin } : {};
      return await start(hubExtract.rest[0], startOpts);
    }

    case "stop": {
      if (isHelpFlag(rest[0])) {
        console.log(stopHelp());
        return 0;
      }
      return await stop(rest[0]);
    }

    case "restart": {
      if (isHelpFlag(rest[0])) {
        console.log(restartHelp());
        return 0;
      }
      return await restart(rest[0]);
    }

    case "upgrade": {
      if (isHelpFlag(rest[0])) {
        console.log(upgradeHelp());
        return 0;
      }
      const tagExtract = extractTag(rest);
      if (tagExtract.error) {
        console.error(`parachute upgrade: ${tagExtract.error}`);
        return 1;
      }
      const remaining = tagExtract.rest;
      if (remaining.length > 1) {
        console.error(`parachute upgrade: unexpected argument "${remaining[1]}"`);
        console.error("usage: parachute upgrade [<service>] [--tag <name>]");
        return 1;
      }
      const upgradeOpts: Parameters<typeof upgrade>[1] = {};
      if (tagExtract.tag) upgradeOpts.tag = tagExtract.tag;
      return await upgrade(remaining[0], upgradeOpts);
    }

    case "logs": {
      if (isHelpFlag(rest[0])) {
        console.log(logsHelp());
        return 0;
      }
      const svc = rest[0];
      if (!svc) {
        console.error("usage: parachute logs <service> [-f]");
        console.error(`services: ${[HUB_SVC, ...knownServices()].join(", ")}`);
        return 1;
      }
      const follow = rest.includes("-f") || rest.includes("--follow");
      return await logs(svc, { follow });
    }

    case "migrate": {
      if (isHelpFlag(rest[0])) {
        console.log(migrateHelp());
        return 0;
      }
      const dryRun = rest.includes("--dry-run");
      const yes = rest.includes("--yes") || rest.includes("-y");
      const unknown = rest.find((a) => a !== "--dry-run" && a !== "--yes" && a !== "-y");
      if (unknown !== undefined) {
        console.error(`parachute migrate: unknown argument "${unknown}"`);
        console.error("usage: parachute migrate [--dry-run] [--yes]");
        return 1;
      }
      return await migrate({ dryRun, yes });
    }

    case "serve": {
      if (isHelpFlag(rest[0])) {
        console.log(serveHelp());
        return 0;
      }
      if (rest.length > 0) {
        console.error(`parachute serve: unexpected argument "${rest[0]}"`);
        console.error("usage: parachute serve");
        return 1;
      }
      // `serve` returns once Bun.serve is bound; the listener keeps the
      // event loop alive until SIGINT/SIGTERM, at which point we stop the
      // server cleanly and exit. Container supervisor (tini, Render, Docker)
      // reaps us once the event loop drains.
      const { stop: stopServer } = await serve();
      await new Promise<void>((resolve) => {
        const handler = async () => {
          await stopServer();
          resolve();
        };
        process.on("SIGINT", handler);
        process.on("SIGTERM", handler);
      });
      return 0;
    }

    case "auth":
      return await auth(rest);

    case "vault": {
      // `parachute vault` with no args forwards --help to parachute-vault so
      // users see the actual vault surface, not a CLI-side stub. Anything
      // after `vault` (including --help) is passed through verbatim.
      if (rest.length === 0) return await dispatchVault(["--help"]);

      // `parachute vault tokens create` in a TTY with no scope-narrowing flag
      // → guided flow. Any of --scope / --read / --permission means the user
      // has already decided, so we stay out of the way. Non-TTY always
      // bypasses (no way to answer a prompt). Label is orthogonal — the
      // guided flow prompts for it only if --label wasn't supplied.
      const wantsGuidedTokenCreate =
        rest[0] === "tokens" &&
        rest[1] === "create" &&
        isTtyInteractive() &&
        !rest.includes("--scope") &&
        !rest.includes("--read") &&
        !rest.includes("--permission") &&
        !isHelpFlag(rest[2]);
      if (wantsGuidedTokenCreate) {
        const { runVaultTokensCreateInteractive } = await import(
          "./commands/vault-tokens-create-interactive.ts"
        );
        return await runVaultTokensCreateInteractive({ args: rest.slice(2) });
      }

      return await dispatchVault(rest);
    }

    default:
      console.error(`parachute: unknown command "${command}"`);
      console.error("run `parachute --help` for usage");
      return 1;
  }
}

async function run(argv: string[]): Promise<number> {
  try {
    return await main(argv);
  } catch (err) {
    if (err instanceof ServicesManifestError) {
      console.error(`services.json is malformed: ${err.message}`);
      console.error("Fix or remove the file, then re-run.");
      return 1;
    }
    if (err instanceof ExposeStateError) {
      console.error(`expose-state.json is malformed: ${err.message}`);
      console.error("If you're stuck, delete ~/.parachute/expose-state.json and re-run.");
      return 1;
    }
    if (err instanceof CloudflaredStateError) {
      console.error(`cloudflared-state.json is malformed: ${err.message}`);
      console.error("If you're stuck, delete ~/.parachute/cloudflared-state.json and re-run.");
      return 1;
    }
    if (err instanceof TailscaleError) {
      console.error(`tailscale command failed: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

const code = await run(process.argv.slice(2));
process.exit(code);
